import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { portableAgentConfigurationSchema, runInputSchema } from './contracts'
import {
  extensionCatalogSchema,
  extensionConfigurationSchema,
  extensionManagementMessageSchema,
  extensionManifestSchema,
  extensionSkillConfigurationFormSchema,
  extensionProgressSchema,
  extensionSourceRequestSchema,
  extensionSourceSchema,
  extensionToolInputSchemaSchema,
  extensionToolResultSchema,
  localExtensionSnapshotSchema,
  parseExtensionManifest,
  createLocalExtensionExecutorSnapshotFromCatalog,
  resolveExtensionExecutorAvailability,
  resolveExtensionToolAvailability,
  validateExtensionSkillConfiguration,
  type ForageExtensionSetup,
} from './extensions'

const manifest = {
  id: 'dev.forage.text-stats',
  name: 'Text Stats',
  version: '0.1.0',
  description: 'Counts words and characters in bounded text.',
  entry: './dist/index.js',
  contributes: {
    tools: [{
      id: 'text_stats',
      name: 'Text statistics',
      description: 'Count words and characters in text.',
    }],
    hooks: ['run:start'],
    settings: [
      { key: 'mode', type: 'select', label: 'Mode', options: [{ value: 'words', label: 'Words' }], default: 'words' },
      { key: 'token', type: 'secret', label: 'Token', required: true },
    ],
  },
} as const

const localSource = {
  kind: 'local',
  installationId: 'installation-1',
  requestedPath: 'projects/text-stats',
  canonicalPath: '/Users/example/.forage/projects/text-stats',
} as const

const digest = 'a'.repeat(64)

const executorManifest = {
  id: 'dev.forage.summary-fixture',
  name: 'Summary fixture',
  version: '0.1.0',
  description: 'Provides deterministic summaries.',
  entry: './dist/index.js',
  contributes: {
    tools: [],
    hooks: [],
    settings: [],
    executors: [{
      id: 'summarize',
      name: 'Summarize notes',
      description: 'Deterministic non-evaluation fixture.',
      configuration: {
        fields: [
          { key: 'heading', label: 'Heading', type: 'text', required: true },
          { key: 'style', label: 'Style', type: 'choice', options: [{ value: 'brief', label: 'Brief' }, { value: 'full', label: 'Full' }] },
          { key: 'sections', label: 'Sections', type: 'repeat', maximumItems: 5, fields: [{ key: 'name', label: 'Name', type: 'text' }] },
        ],
        branches: [{ when: { field: 'style', equals: 'full' }, fields: [{ key: 'details', label: 'Details', type: 'multiline' }] }],
      },
    }],
  },
} as const

describe('Forage extension manifest contracts', () => {
  it('accepts the single current manifest and rejects versioned or Pi-shaped manifests', () => {
    expect(extensionManifestSchema.parse(manifest).id).toBe('dev.forage.text-stats')
    expect(() => extensionManifestSchema.parse({ ...manifest, manifestVersion: 1 })).toThrow()
    expect(() => extensionManifestSchema.parse({ ...manifest, apiVersion: '1' })).toThrow()
    expect(() => extensionManifestSchema.parse({
      name: 'Pi extension',
      extensions: ['./index.ts'],
    })).toThrow()
  })

  it('accepts bounded generic executor forms inspectable without code import', () => {
    expect(extensionManifestSchema.parse(executorManifest)).toEqual(executorManifest)
    expect(extensionManifestSchema.parse(executorManifest).contributes.executors?.[0]).toMatchObject({
      id: 'summarize', configuration: { fields: expect.any(Array), branches: expect.any(Array) },
    })
    expect(() => extensionManifestSchema.parse({
      ...executorManifest,
      contributes: { ...executorManifest.contributes, executors: [{ ...executorManifest.contributes.executors[0], configuration: { fields: [{ key: 'markup', label: 'Markup', type: 'html' }] } }] },
    })).toThrow()
    expect(() => extensionManifestSchema.parse({
      ...executorManifest,
      contributes: {
        ...executorManifest.contributes,
        executors: [{ ...executorManifest.contributes.executors[0], configuration: { fields: [], branches: [{ when: { field: 'missing', equals: true }, fields: [{ key: 'detail', label: 'Detail', type: 'text' }] }] } }],
      },
    })).toThrow(/top-level/i)
    expect(() => extensionSkillConfigurationFormSchema.parse({
      fields: [{ key: 'items', label: 'Items', type: 'repeat', maximumItems: 51, fields: [{ key: 'name', label: 'Name', type: 'text' }] }],
    })).toThrow()
  })

  it('has no extension manifest or API version negotiation path', () => {
    expect(() => extensionManifestSchema.parse({ ...manifest, manifestVersion: 7 })).toThrow()
    expect(() => extensionManifestSchema.parse({ ...manifest, apiVersion: '7' })).toThrow()
  })

  it('validates generic values, conditional branches, objects, and repeated-group bounds', () => {
    const form = {
      fields: [
        { key: 'mode', label: 'Mode', type: 'choice' as const, options: [{ value: 'simple', label: 'Simple' }, { value: 'advanced', label: 'Advanced' }] },
        { key: 'items', label: 'Items', type: 'repeat' as const, minimumItems: 1, maximumItems: 2, fields: [
          { key: 'label', label: 'Label', type: 'text' as const, required: true, maxLength: 10 },
        ] },
      ],
      branches: [{ when: { field: 'mode', equals: 'advanced' }, fields: [
        { key: 'details', label: 'Details', type: 'object' as const, fields: [{ key: 'enabled', label: 'Enabled', type: 'boolean' as const, required: true }] },
      ] }],
    }
    expect(validateExtensionSkillConfiguration(form, {
      mode: 'advanced', items: [{ label: 'One' }], details: { enabled: true },
    })).toEqual({ valid: true })
    expect(validateExtensionSkillConfiguration(form, {
      mode: 'simple', items: [{ label: 'One' }], details: { enabled: 'retained while hidden' },
    })).toEqual({ valid: true })
    expect(validateExtensionSkillConfiguration(form, {
      mode: 'advanced', items: [], details: { enabled: 'yes' }, extra: true,
    })).toMatchObject({ valid: false, issues: expect.arrayContaining([
      expect.objectContaining({ path: ['items'] }),
      expect.objectContaining({ path: ['details', 'enabled'] }),
      expect.objectContaining({ path: ['extra'] }),
    ]) })
  })

  it('confines entry paths and rejects duplicate or invalid contributions', () => {
    expect(() => extensionManifestSchema.parse({ ...manifest, entry: './../outside.js' })).toThrow(/confined/i)
    expect(() => extensionManifestSchema.parse({ ...manifest, entry: './dist/../../outside.js' })).toThrow(/confined/i)
    expect(() => extensionManifestSchema.parse({ ...manifest, entry: '.\\dist\\index.js' })).toThrow(/confined/i)
    expect(() => extensionManifestSchema.parse({ ...manifest, id: 'text-stats' })).toThrow(/reverse-DNS/i)
    expect(() => extensionManifestSchema.parse({
      ...manifest,
      contributes: { ...manifest.contributes, tools: [...manifest.contributes.tools, manifest.contributes.tools[0]] },
    })).toThrow(/unique/i)
    expect(() => extensionManifestSchema.parse({
      ...manifest,
      contributes: {
        ...manifest.contributes,
        settings: [{ key: 'region', type: 'select', label: 'Region', options: [{ value: 'eu', label: 'EU' }], default: 'us' }],
      },
    })).toThrow(/option/i)
  })

  it('bounds and strictly parses serialized manifests', () => {
    expect(parseExtensionManifest(JSON.stringify(manifest))).toMatchObject({ id: manifest.id, version: manifest.version })
    expect(() => parseExtensionManifest('{not json')).toThrow()
    expect(() => parseExtensionManifest(JSON.stringify({ ...manifest, extra: true }))).toThrow()
    expect(() => parseExtensionManifest(' '.repeat(64_001))).toThrow(/too large/i)
  })
})

describe('Forage extension source, catalog, and configuration contracts', () => {
  it('distinguishes requested sources from resolved installation provenance', () => {
    expect(extensionSourceRequestSchema.parse({ kind: 'local', path: 'projects/text-stats' })).toEqual({
      kind: 'local', path: 'projects/text-stats',
    })
    expect(extensionSourceRequestSchema.parse({ kind: 'npm', spec: '@forage/text-stats@1.2.3' }).kind).toBe('npm')
    expect(extensionSourceRequestSchema.parse({ kind: 'git', url: 'https://example.com/tools.git', ref: 'v1' }).kind).toBe('git')
    expect(extensionSourceSchema.parse(localSource).canonicalPath).toBe(localSource.canonicalPath)
    expect(() => extensionSourceSchema.parse({ ...localSource, canonicalPath: '../relative' })).toThrow(/absolute/i)
  })

  it('requires stable unique installation identities and matching provenance', () => {
    const configurationSource = {
      installationId: 'installation-1',
      source: { kind: 'local', path: 'projects/text-stats' },
      enabled: false,
      trust: { accepted: false },
      settings: {},
    }
    expect(extensionConfigurationSchema.parse({ version: 1, revision: 0, sources: [configurationSource] }).sources).toHaveLength(1)
    expect(() => extensionConfigurationSchema.parse({
      version: 1,
      revision: 0,
      sources: [configurationSource, configurationSource],
    })).toThrow(/unique/i)
    expect(() => extensionConfigurationSchema.parse({
      version: 1,
      revision: 0,
      sources: [{ ...configurationSource, enabled: true }],
    })).toThrow(/trust/i)

    expect(() => extensionCatalogSchema.parse({
      version: 1,
      revision: digest,
      entries: [{
        source: localSource,
        manifest,
        provenance: {
          installationId: 'different-installation',
          extensionId: manifest.id,
          sourceKind: 'local',
          sourceRevision: digest,
          entryDigest: digest,
        },
        status: 'ready',
        tools: [],
        diagnostics: [],
      }],
    })).toThrow(/installation id/i)
  })

  it('keeps secret material and local extension state out of portable configuration', () => {
    expect(() => extensionConfigurationSchema.parse({
      version: 1,
      revision: 0,
      sources: [{
        installationId: 'installation-1',
        source: { kind: 'local', path: 'extension' },
        enabled: true,
        trust: { accepted: true, extensionId: manifest.id },
        settings: {},
        secrets: { token: 'plaintext' },
      }],
    })).toThrow()
    expect(extensionConfigurationSchema.parse({
      version: 1,
      revision: 0,
      sources: [{
        installationId: 'installation-1',
        source: { kind: 'local', path: 'extension' },
        enabled: true,
        trust: { accepted: true, extensionId: manifest.id },
        settings: {},
        secretReferences: { token: 'forage-extension/installation-1/token' },
      }],
    }).sources[0].secretReferences).toEqual({ token: 'forage-extension/installation-1/token' })

    const portable = {
      version: 3,
      revision: 1,
      agents: [],
      skills: [],
      customTools: [],
      globallyEnabledToolIds: ['text_stats'],
    }
    expect(portableAgentConfigurationSchema.parse(portable).globallyEnabledToolIds).toEqual(['text_stats'])
    expect(() => portableAgentConfigurationSchema.parse({ ...portable, extensions: [localSource] })).toThrow()

    const portableRun = {
      version: 1,
      runId: 'run-1',
      executionMode: 'local',
      outlineId: 'outline-1',
      source: { nodeId: 'node-1' },
      target: { parentId: 'node-1' },
      baseRevision: 1,
      configurationRevision: 1,
      credentialRef: 'credential-1',
      agent: {
        id: 'agent-1', name: 'Agent', description: 'Agent description', systemPrompt: 'Act.', modelId: '', toolIds: ['text_stats'],
      },
      skill: {
        id: 'skill-1', label: 'stats', description: 'Count text', systemPrompt: 'Count.', agentId: 'agent-1', requiredToolIds: [],
      },
      effectiveToolIds: ['text_stats'],
      prompt: 'Count this.',
      context: [],
    }
    expect(runInputSchema.parse(portableRun).runId).toBe('run-1')
    expect(() => runInputSchema.parse({ ...portableRun, extensionSnapshot: { version: 1 } })).toThrow()
    expect(localExtensionSnapshotSchema.parse({
      version: 1,
      catalogRevision: digest,
      configurationRevision: 4,
      sources: [{
        installationId: 'installation-1',
        extensionId: manifest.id,
        sourceRevision: digest,
        entryDigest: digest,
        toolIds: ['text_stats'],
        hooks: ['run:start'],
      }],
    }).sources[0].toolIds).toEqual(['text_stats'])
  })
})

describe('Forage extension identity and collision policy', () => {
  it('fails duplicate tool providers closed independent of input order', () => {
    const inputs = [
      { installationId: 'installation-b', extensionId: 'dev.example.second', toolIds: ['shared_tool'] },
      { installationId: 'installation-a', extensionId: 'dev.example.first', toolIds: ['shared_tool'] },
    ]
    const forward = resolveExtensionToolAvailability(inputs)
    const reverse = resolveExtensionToolAvailability([...inputs].reverse())
    expect(forward).toEqual(reverse)
    expect(forward).toEqual([
      expect.objectContaining({ installationId: 'installation-a', available: false, diagnosticCode: 'duplicate_tool_provider' }),
      expect.objectContaining({ installationId: 'installation-b', available: false, diagnosticCode: 'duplicate_tool_provider' }),
    ])
  })

  it('qualifies executor identity by extension and fails conflicting active installations closed', () => {
    expect(resolveExtensionExecutorAvailability([
      { installationId: 'a', extensionId: 'dev.example.same', executorIds: ['summarize'] },
      { installationId: 'b', extensionId: 'dev.example.same', executorIds: ['summarize'] },
      { installationId: 'c', extensionId: 'dev.example.other', executorIds: ['summarize'] },
    ])).toEqual([
      expect.objectContaining({ installationId: 'a', executorId: 'summarize', available: false, diagnosticCode: 'duplicate_extension_id' }),
      expect.objectContaining({ installationId: 'b', executorId: 'summarize', available: false, diagnosticCode: 'duplicate_extension_id' }),
      expect.objectContaining({ installationId: 'c', executorId: 'summarize', available: true }),
    ])
  })

  it('creates executor admission snapshots only from one ready declared owner', () => {
    const source = { ...localSource, installationId: 'executor-installation' }
    const catalog = extensionCatalogSchema.parse({
      version: 1,
      revision: digest,
      entries: [{
        source,
        manifest: executorManifest,
        provenance: {
          installationId: source.installationId,
          extensionId: executorManifest.id,
          sourceKind: 'local',
          sourceRevision: 'b'.repeat(64),
          entryDigest: 'c'.repeat(64),
        },
        status: 'ready',
        tools: [],
        executors: [{ ...executorManifest.contributes.executors[0], available: true, diagnostics: [] }],
        diagnostics: [],
      }],
    })
    const snapshot = createLocalExtensionExecutorSnapshotFromCatalog(catalog, 7, {
      extensionId: executorManifest.id,
      executorId: 'summarize',
    })
    expect(snapshot).toMatchObject({
      configurationRevision: 7,
      source: { installationId: source.installationId, executorId: 'summarize' },
    })
    expect(() => createLocalExtensionExecutorSnapshotFromCatalog(catalog, 7, {
      extensionId: executorManifest.id, executorId: 'undeclared',
    })).toThrow(/unavailable/i)
  })

  it('rejects duplicate extension identities, custom HTTP collisions, and reserved tools', () => {
    const availability = resolveExtensionToolAvailability([
      { installationId: 'duplicate-a', extensionId: 'dev.example.duplicate', toolIds: ['first_tool'] },
      { installationId: 'duplicate-b', extensionId: 'dev.example.duplicate', toolIds: ['second_tool'] },
      { installationId: 'custom', extensionId: 'dev.example.custom', toolIds: ['weather_lookup'] },
      { installationId: 'output', extensionId: 'dev.example.output', toolIds: ['emit_outline'] },
    ], ['weather_lookup'])
    expect(availability.find((item) => item.installationId === 'duplicate-a')?.diagnosticCode).toBe('duplicate_extension_id')
    expect(availability.find((item) => item.installationId === 'duplicate-b')?.diagnosticCode).toBe('duplicate_extension_id')
    expect(availability.find((item) => item.installationId === 'custom')?.diagnosticCode).toBe('custom_tool_collision')
    expect(availability.find((item) => item.installationId === 'output')?.diagnosticCode).toBe('reserved_tool_id')
    expect(() => resolveExtensionToolAvailability([
      { installationId: 'invalid', extensionId: 'not-reverse-dns', toolIds: ['Not_Valid'] },
    ])).toThrow()
  })
})

describe('Forage extension host API contracts', () => {
  it('defines registration, hooks, cancellation, progress, logging, and bounded results without an engine dependency', async () => {
    const registered: string[] = []
    const setup: ForageExtensionSetup = (forage) => {
      forage.registerTool({
        id: 'text_stats',
        name: 'Text statistics',
        description: 'Count text.',
        inputSchema: { type: 'object' },
        async execute(input, context) {
          context.signal.throwIfAborted()
          context.reportProgress({ message: 'Counting', completed: 1, total: 1 })
          context.log({ level: 'info', message: 'Counted text' })
          return { json: { received: typeof input === 'object' } }
        },
      })
      forage.on('run:start', () => undefined)
      forage.on('run:end', ({ outcome }) => { registered.push(outcome) })
    }
    expect(setup).toBeTypeOf('function')
    expect(extensionToolResultSchema.parse({ text: 'Words: 3' })).toEqual({ text: 'Words: 3' })
    expect(extensionToolResultSchema.parse({ json: { words: 3 } })).toEqual({ json: { words: 3 } })
    expect(extensionToolInputSchemaSchema.parse({
      type: 'object',
      properties: { text: { type: 'string', maxLength: 20_000 } },
      required: ['text'],
      additionalProperties: false,
    }).type).toBe('object')
    expect(() => extensionToolInputSchemaSchema.parse({ description: 'x'.repeat(20_001) })).toThrow(/too large/i)
    expect(() => extensionToolResultSchema.parse({ text: 'x'.repeat(100_001) })).toThrow()
    expect(extensionProgressSchema.parse({ message: 'Halfway', completed: 1, total: 2 }).total).toBe(2)
    expect(() => extensionProgressSchema.parse({ message: 'Impossible', completed: 3, total: 2 })).toThrow()
  })

  it('does not couple the native contract module to Pi or application frameworks', () => {
    const source = readFileSync(path.resolve(process.cwd(), 'packages/agent-runtime/src/extensions.ts'), 'utf8')
    for (const forbidden of ['@earendil-works/', '@tauri-apps/', "from 'react'", '@forage/desktop', '@forage/server']) {
      expect(source).not.toContain(forbidden)
    }
  })
})

describe('Forage extension management messages', () => {
  it('accepts request-correlated bounded operations and rejects malformed messages', () => {
    expect(extensionManagementMessageSchema.parse({
      version: 1,
      kind: 'request',
      requestId: 'request-1',
      operation: 'install',
      source: { kind: 'npm', spec: '@forage/text-stats@1.0.0' },
    }).kind).toBe('request')
    expect(extensionManagementMessageSchema.parse({
      version: 1,
      kind: 'request',
      requestId: 'request-preview',
      operation: 'preview_install',
      source: { kind: 'git', url: 'git@example.com:team/tools.git', ref: 'v1.0.0' },
    }).kind).toBe('request')
    expect(extensionManagementMessageSchema.parse({
      version: 1,
      kind: 'response',
      requestId: 'request-1',
      operation: 'install',
      ok: false,
      diagnostics: [{ code: 'invalid_manifest', severity: 'error', message: 'Manifest is invalid.' }],
    }).kind).toBe('response')
    expect(extensionManagementMessageSchema.parse({
      version: 1,
      kind: 'response',
      requestId: 'request-2',
      operation: 'inventory',
      ok: true,
      catalog: { version: 1, revision: digest, entries: [] },
      configuration: { version: 1, revision: 0, sources: [] },
      extensionsDirectory: '/Users/example/.forage/extensions',
    }).kind).toBe('response')
    expect(() => extensionManagementMessageSchema.parse({
      version: 1,
      kind: 'request',
      operation: 'remove',
      installationId: 'installation-1',
    })).toThrow()
    expect(() => extensionManagementMessageSchema.parse({
      version: 1,
      kind: 'response',
      requestId: 'request-1',
      operation: 'inventory',
      ok: false,
      diagnostics: [],
    })).toThrow()
    expect(() => extensionManagementMessageSchema.parse({
      version: 1,
      kind: 'response',
      requestId: 'request-1',
      operation: 'remove',
      ok: true,
      catalog: { version: 1, revision: digest, entries: [] },
    })).toThrow(/operation/i)
  })
})
