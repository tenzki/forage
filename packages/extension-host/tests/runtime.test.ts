import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ExtensionConfiguration, ExtensionSourceConfiguration } from '@forage/agent-runtime'
import { inventoryExtensions } from '../src/inventory'
import { ExtensionRevisionRegistry, createLocalExtensionSnapshot, verifyLocalExtensionSnapshot } from '../src/snapshot'
import {
  loadForageExtension,
  runExtensionEndHooks,
  runExtensionStartHooks,
  sanitizeExtensionText,
  validateForageExtensionEntry,
} from '../src/runtime'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixture(entrySource: string, overrides: Record<string, unknown> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'forage-extension-runtime-'))
  temporaryDirectories.push(root)
  const source = path.join(root, 'source')
  await mkdir(path.join(source, 'dist'), { recursive: true })
  const manifest = {
    id: 'dev.example.runtime',
    name: 'Runtime fixture',
    version: '1.0.0',
    description: 'Exercises the native runtime host.',
    entry: './dist/index.mjs',
    contributes: {
      tools: [{ id: 'fixture_tool', name: 'Fixture tool', description: 'Runs a fixture.' }],
      hooks: ['run:start', 'run:end'],
      settings: [
        { key: 'prefix', label: 'Prefix', type: 'string', default: 'default' },
        { key: 'token', label: 'Token', type: 'secret' },
      ],
    },
    ...overrides,
  }
  await writeFile(path.join(source, 'forage.extension.json'), JSON.stringify(manifest), 'utf8')
  await writeFile(path.join(source, 'dist/index.mjs'), entrySource, 'utf8')
  const sourceConfiguration: ExtensionSourceConfiguration = {
    installationId: 'installation-runtime',
    source: { kind: 'local', path: source },
    enabled: true,
    trust: { accepted: true, extensionId: 'dev.example.runtime' },
    settings: { prefix: 'configured' },
    secretReferences: { token: 'forage-extension/installation-runtime/token' },
  }
  const configuration: ExtensionConfiguration = { version: 1, revision: 4, sources: [sourceConfiguration] }
  const catalog = await inventoryExtensions({ configurationRoot: root, configuration })
  return { root, source, configuration, sourceConfiguration, catalog, entry: catalog.entries[0]! }
}

const conformingEntry = `
export default async function setup(host) {
  console.log('setup noise')
  host.on('run:start', async (context) => context.log({ level: 'info', message: 'started ' + context.settings.prefix }))
  host.on('run:end', async (context) => context.log({ level: 'info', message: 'ended ' + context.outcome }))
  host.registerTool({
    id: 'fixture_tool', name: 'Fixture tool', description: 'Runs a fixture.',
    inputSchema: { type: 'object', properties: { value: { type: 'string', maxLength: 20 } }, required: ['value'], additionalProperties: false },
    async execute(input, context) {
      console.log('execute noise')
      context.signal.throwIfAborted()
      context.reportProgress({ message: 'working', completed: 1, total: 1 })
      context.log({ level: 'info', message: 'used token', data: { available: Boolean(context.secrets.token) } })
      return { text: context.settings.prefix + ':' + input.value }
    }
  })
}`

describe('Forage extension runtime host', () => {
  it('loads in setup order and exposes validated tools, hooks, settings, secrets, progress, and logs', async () => {
    const fixtureValue = await fixture(conformingEntry)
    const stderr: string[] = []
    const progress: unknown[] = []
    const logs: unknown[] = []
    const loaded = await loadForageExtension(fixtureValue.entry, {
      configuration: fixtureValue.sourceConfiguration,
      stderr: (line) => stderr.push(line),
    })
    const controller = new AbortController()
    const context = {
      signal: controller.signal,
      secrets: { token: 'private-token', undeclared: 'hidden' },
      onProgress: (value: unknown) => progress.push(value),
      onLog: (value: unknown) => logs.push(value),
    }

    await loaded.runStart('run-1', context)
    await expect(loaded.executeTool('fixture_tool', { value: 'hello' }, context)).resolves.toEqual({ text: 'configured:hello' })
    await loaded.runEnd('run-1', 'completed', context)

    expect(progress).toEqual([{ message: 'working', completed: 1, total: 1 }])
    expect(logs).toEqual([
      expect.objectContaining({ message: 'started configured', installationId: 'installation-runtime' }),
      expect.objectContaining({ message: 'used token', data: { available: true } }),
      expect.objectContaining({ message: 'ended completed' }),
    ])
    expect(stderr).toEqual(['setup noise', 'execute noise'])
  })

  it('fails closed when runtime registrations differ from the manifest', async () => {
    const fixtureValue = await fixture(`export default (host) => host.registerTool({
      id: 'undeclared', name: 'Other', description: 'Other tool',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async execute() { return { text: 'no' } }
    })`)
    const result = await validateForageExtensionEntry(fixtureValue.entry, fixtureValue.sourceConfiguration)
    expect(result.diagnostics[0]).toMatchObject({ code: 'manifest_runtime_tool_mismatch' })
  })

  it.each([
    ['executor id', "id: 'undeclared'", "name: 'Summarize'", "configuration: { fields: [] }"],
    ['metadata', "id: 'summarize'", "name: 'Other'", "configuration: { fields: [] }"],
    ['configuration', "id: 'summarize'", "name: 'Summarize'", "configuration: { fields: [{ key: 'other', label: 'Other', type: 'text' }] }"],
  ])('fails closed when runtime %s differs from its executor declaration', async (_case, id, name, configuration) => {
    const value = await fixture(`export default (host) => host.registerSkillExecutor({
      ${id}, ${name}, description: 'Formats notes.', ${configuration},
      async validateConfiguration() { return { valid: true } },
      async prepare() { return { selectedNodeIds: [], requestedReferenceIds: [], annotations: [], data: {} } },
      async execute() { return { nodes: [{ type: 'text', segments: [{ type: 'text', text: 'Done' }] }] } }
    })`, {
      contributes: {
        tools: [], hooks: [], settings: [], executors: [{
          id: 'summarize', name: 'Summarize', description: 'Formats notes.', configuration: { fields: [] },
        }],
      },
    })
    const result = await validateForageExtensionEntry(value.entry, value.sourceConfiguration)
    expect(result.diagnostics[0]).toMatchObject({ code: 'manifest_runtime_executor_mismatch' })
  })

  it('rejects unsupported schemas and invalid or oversized results', async () => {
    const unsupported = await fixture(`export default (host) => {
      host.on('run:start', () => {}); host.on('run:end', () => {});
      host.registerTool({ id: 'fixture_tool', name: 'Fixture tool', description: 'Runs a fixture.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: true }, async execute() { return { text: 'ok' } } })
    }`)
    expect((await validateForageExtensionEntry(unsupported.entry, unsupported.sourceConfiguration)).diagnostics[0])
      .toMatchObject({ code: 'unsupported_tool_schema' })

    const invalid = await fixture(conformingEntry.replace("return { text: context.settings.prefix + ':' + input.value }", "return { text: 'x'.repeat(100001) }"))
    const loaded = await loadForageExtension(invalid.entry, { configuration: invalid.sourceConfiguration })
    await expect(loaded.executeTool('fixture_tool', { value: 'x' }, { signal: new AbortController().signal }))
      .rejects.toThrow()
  })

  it('propagates cancellation and rejects source changes before execution', async () => {
    const fixtureValue = await fixture(conformingEntry)
    const loaded = await loadForageExtension(fixtureValue.entry, { configuration: fixtureValue.sourceConfiguration })
    const controller = new AbortController()
    controller.abort('cancelled')
    await expect(loaded.executeTool('fixture_tool', { value: 'x' }, { signal: controller.signal })).rejects.toThrow()

    await writeFile(path.join(fixtureValue.source, 'dist/index.mjs'), `${conformingEntry}\n// changed`, 'utf8')
    await expect(loadForageExtension(fixtureValue.entry, { configuration: fixtureValue.sourceConfiguration }))
      .rejects.toMatchObject({ code: 'stale_extension_revision' })
  })

  it('rejects changed path ownership and sanitizes known secrets in bounded diagnostics', async () => {
    const fixtureValue = await fixture(conformingEntry)
    const outside = path.join(fixtureValue.root, 'outside.mjs')
    await writeFile(outside, conformingEntry, 'utf8')
    await rm(path.join(fixtureValue.source, 'dist/index.mjs'))
    await symlink(outside, path.join(fixtureValue.source, 'dist/index.mjs'))
    await expect(loadForageExtension(fixtureValue.entry, { configuration: fixtureValue.sourceConfiguration }))
      .rejects.toMatchObject({ code: 'source_ownership_changed' })
    expect(sanitizeExtensionText('token private-token leaked', ['private-token'])).toBe('token [REDACTED] leaked')
  })

  it('runs setup hooks in source order and teardown hooks in reverse order', async () => {
    const order: string[] = []
    const extension = (name: string) => ({
      runStart: async () => { order.push(`start:${name}`) },
      runEnd: async () => { order.push(`end:${name}`) },
    }) as unknown as Awaited<ReturnType<typeof loadForageExtension>>
    const options = { signal: new AbortController().signal }
    await runExtensionStartHooks([extension('a'), extension('b')], 'run-1', options)
    await runExtensionEndHooks([extension('a'), extension('b')], 'run-1', 'completed', options)
    expect(order).toEqual(['start:a', 'start:b', 'end:b', 'end:a'])
  })
})

describe('extension admission snapshots and reloads', () => {
  it('verifies source/tool/configuration provenance and rejects stale retries', async () => {
    const fixtureValue = await fixture(conformingEntry)
    const snapshot = createLocalExtensionSnapshot(fixtureValue.catalog, fixtureValue.configuration, ['fixture_tool'])
    expect(snapshot.sources[0]).toMatchObject({ extensionId: 'dev.example.runtime', toolIds: ['fixture_tool'] })
    expect(() => verifyLocalExtensionSnapshot(snapshot, fixtureValue.catalog, fixtureValue.configuration)).not.toThrow()
    expect(() => verifyLocalExtensionSnapshot(snapshot, fixtureValue.catalog, { ...fixtureValue.configuration, revision: 5 }))
      .toThrow(/retry/i)
    expect(() => verifyLocalExtensionSnapshot(snapshot, { ...fixtureValue.catalog, entries: [] }, fixtureValue.configuration))
      .toThrow(/no longer available/i)
    const retry = createLocalExtensionSnapshot(fixtureValue.catalog, fixtureValue.configuration, ['fixture_tool'])
    expect(() => verifyLocalExtensionSnapshot(retry, fixtureValue.catalog, fixtureValue.configuration)).not.toThrow()
  })

  it('keeps active implementations while reload changes future acquisitions', () => {
    const registry = new ExtensionRevisionRegistry<{ value: number }>()
    registry.reload('one', { value: 1 })
    const active = registry.acquire()
    registry.reload('two', { value: 2 })
    const future = registry.acquire()
    expect(active.value.value).toBe(1)
    expect(future.value.value).toBe(2)
    active.release()
    future.release()
  })
})
