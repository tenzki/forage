import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ExtensionConfiguration } from '@forage/agent-runtime'
import { inventoryExtensions } from '../src/inventory'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function temporaryDirectory(prefix = 'forage-extension-inventory-'): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix))
  temporaryDirectories.push(directory)
  return directory
}

function manifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'dev.example.weather',
    name: 'Weather',
    version: '1.0.0',
    description: 'Reports deterministic fixture weather.',
    entry: './dist/index.js',
    contributes: {
      tools: [{ id: 'weather_lookup', name: 'Weather lookup', description: 'Look up weather.' }],
      hooks: [],
      settings: [],
    },
    ...overrides,
  }
}

function executorManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'dev.example.summary',
    name: 'Summary fixture',
    version: '1.0.0',
    description: 'Provides deterministic summaries.',
    entry: './dist/index.js',
    contributes: {
      tools: [],
      hooks: [],
      settings: [],
      executors: [{
        id: 'summarize', name: 'Summarize', description: 'Formats selected notes.',
        configuration: { fields: [{ key: 'heading', label: 'Heading', type: 'text' }] },
      }],
    },
    ...overrides,
  }
}

async function writeExtension(
  directory: string,
  manifestValue = manifest(),
  entrySource = 'globalThis.__forageExtensionFixtureLoaded = true',
): Promise<void> {
  await mkdir(path.join(directory, 'dist'), { recursive: true })
  await writeFile(path.join(directory, 'forage.extension.json'), JSON.stringify(manifestValue), 'utf8')
  await writeFile(path.join(directory, 'dist', 'index.js'), entrySource, 'utf8')
}

function localConfiguration(
  sourcePath: string,
  overrides: Partial<ExtensionConfiguration['sources'][number]> = {},
): ExtensionConfiguration {
  return {
    version: 1,
    revision: 1,
    sources: [{
      installationId: 'installation-weather',
      source: { kind: 'local', path: sourcePath },
      enabled: false,
      trust: { accepted: false },
      settings: {},
      ...overrides,
    }],
  }
}

describe('manifest-only extension inventory', () => {
  it('discovers manifest-bearing directories without importing entries and ignores loose or Pi-only inputs', async () => {
    const root = await temporaryDirectory()
    const discovered = path.join(root, 'extensions', 'weather')
    await writeExtension(discovered, manifest(), 'throw new Error("entry must not execute during inventory")')
    await writeFile(path.join(root, 'extensions', 'loose.js'), 'throw new Error("ignored")', 'utf8')
    await mkdir(path.join(root, 'extensions', 'pi-only'), { recursive: true })
    await writeFile(path.join(root, 'extensions', 'pi-only', 'package.json'), JSON.stringify({ pi: { extensions: ['./index.js'] } }), 'utf8')

    const catalog = await inventoryExtensions({ configurationRoot: root })

    expect(catalog.entries).toHaveLength(1)
    expect(catalog.entries[0]).toMatchObject({
      status: 'needs_review',
      manifest: { id: 'dev.example.weather' },
      source: { kind: 'drop-in', directoryName: 'weather' },
    })
    expect(globalThis).not.toHaveProperty('__forageExtensionFixtureLoaded')
  })

  it('shows untrusted executor forms without importing executor code', async () => {
    const root = await temporaryDirectory()
    const discovered = path.join(root, 'extensions', 'summary')
    await writeExtension(discovered, executorManifest(), 'throw new Error("untrusted executor must not import")')

    const [entry] = (await inventoryExtensions({ configurationRoot: root })).entries

    expect(entry).toMatchObject({
      status: 'needs_review',
      executors: [{
        id: 'summarize', available: false,
        configuration: { fields: [{ key: 'heading', type: 'text' }] },
      }],
    })
  })

  it('inventories configured local and managed sources without loading either entry', async () => {
    const root = await temporaryDirectory()
    const local = path.join(root, 'projects', 'local-weather')
    const managed = path.join(root, 'packages', 'managed-weather', '1.0.0')
    await writeExtension(local)
    await writeExtension(managed, manifest({ id: 'dev.example.managed', name: 'Managed weather' }))
    const configuration: ExtensionConfiguration = {
      version: 1,
      revision: 1,
      sources: [
        localConfiguration('projects/local-weather').sources[0],
        {
          installationId: 'installation-managed',
          source: { kind: 'npm', spec: '@example/managed-weather@1.0.0' },
          resolvedSource: {
            kind: 'npm',
            installationId: 'installation-managed',
            spec: '@example/managed-weather@1.0.0',
            resolvedVersion: '1.0.0',
            canonicalPath: managed,
          },
          enabled: false,
          trust: { accepted: false },
          settings: {},
        },
      ],
    }

    const catalog = await inventoryExtensions({ configurationRoot: root, configuration })

    expect(catalog.entries.map((entry) => entry.source.kind).sort()).toEqual(['local', 'npm'])
    expect(catalog.entries.every((entry) => entry.status === 'needs_review')).toBe(true)
  })

  it('rejects manifests with removed version discriminators without importing their entry', async () => {
    const root = await temporaryDirectory()
    const extension = path.join(root, 'extensions', 'versioned')
    await writeExtension(extension, manifest({ manifestVersion: 1, apiVersion: '1' }), 'throw new Error("invalid manifest must not import")')

    const [entry] = (await inventoryExtensions({ configurationRoot: root })).entries

    expect(entry.status).toBe('error')
    expect(entry.manifest).toBeUndefined()
    expect(entry.tools).toEqual([])
    expect(entry.executors).toEqual([])
    expect(entry.diagnostics).toEqual([expect.objectContaining({ code: 'invalid_manifest' })])
  })

  it('confines manifest and entry symlinks to the extension root', async () => {
    const root = await temporaryDirectory()
    const extension = path.join(root, 'extensions', 'escaping')
    const outside = path.join(root, 'outside.js')
    await mkdir(path.join(extension, 'dist'), { recursive: true })
    await writeFile(path.join(extension, 'forage.extension.json'), JSON.stringify(manifest()), 'utf8')
    await writeFile(outside, 'export default () => undefined', 'utf8')
    await symlink(outside, path.join(extension, 'dist', 'index.js'))

    const [entry] = (await inventoryExtensions({ configurationRoot: root })).entries

    expect(entry.status).toBe('error')
    expect(entry.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'entry_path_escape' })]))
  })

  it('validates static settings and recognizes scoped secret references as configured', async () => {
    const root = await temporaryDirectory()
    const extension = path.join(root, 'weather')
    await writeExtension(extension, manifest({
      contributes: {
        tools: [{ id: 'weather_lookup', name: 'Weather lookup', description: 'Look up weather.' }],
        hooks: ['run:start'],
        settings: [
          { key: 'region', label: 'Region', type: 'select', options: [{ value: 'eu', label: 'EU' }], required: true },
          { key: 'api_token', label: 'API token', type: 'secret', required: true },
        ],
      },
    }))
    const base = localConfiguration(extension, {
      enabled: true,
      trust: { accepted: true, extensionId: 'dev.example.weather' },
    })

    const missing = await inventoryExtensions({ configurationRoot: root, configuration: base })
    expect(missing.entries[0].status).toBe('needs_configuration')
    expect(missing.entries[0].diagnostics.map((item) => item.code)).toEqual([
      'missing_required_setting',
      'missing_required_setting',
    ])

    const ready = await inventoryExtensions({
      configurationRoot: root,
      configuration: localConfiguration(extension, {
        enabled: true,
        trust: { accepted: true, extensionId: 'dev.example.weather' },
        settings: { region: 'eu' },
        secretReferences: { api_token: 'forage-extension/installation-weather/api_token' },
      }),
    })
    expect(ready.entries[0]).toMatchObject({ status: 'ready', tools: [{ id: 'weather_lookup', available: true }] })
  })

  it('marks duplicate qualified executors unavailable independent of source order', async () => {
    const root = await temporaryDirectory()
    const first = path.join(root, 'first')
    const second = path.join(root, 'second')
    await writeExtension(first, executorManifest())
    await writeExtension(second, executorManifest())
    const configured = (installationId: string, sourcePath: string): ExtensionConfiguration['sources'][number] => ({
      installationId,
      source: { kind: 'local', path: sourcePath },
      enabled: true,
      trust: { accepted: true, extensionId: 'dev.example.summary' },
      settings: {},
    })
    const catalog = await inventoryExtensions({
      configurationRoot: root,
      configuration: { version: 1, revision: 1, sources: [configured('executor-b', second), configured('executor-a', first)] },
    })

    expect(catalog.entries.map((entry) => entry.source.installationId)).toEqual(['executor-a', 'executor-b'])
    expect(catalog.entries.every((entry) => (
      entry.status === 'error'
      && entry.executors?.[0]?.available === false
      && entry.diagnostics.some((diagnostic) => diagnostic.code === 'duplicate_extension_id')
    ))).toBe(true)
  })

  it('rejects Pi-only configured packages with a bounded diagnostic', async () => {
    const root = await temporaryDirectory()
    const extension = path.join(root, 'pi-only')
    await mkdir(extension, { recursive: true })
    await writeFile(path.join(extension, 'package.json'), JSON.stringify({ pi: { extensions: ['./index.js'] } }), 'utf8')

    const [entry] = (await inventoryExtensions({
      configurationRoot: root,
      configuration: localConfiguration(extension),
    })).entries

    expect(entry.status).toBe('error')
    expect(entry.manifest).toBeUndefined()
    expect(entry.diagnostics[0]).toMatchObject({ code: 'missing_manifest' })
    expect(entry.diagnostics[0].message).toMatch(/Pi-only packages/)
  })

  it('does not inspect ambient working-directory Forage, Pi, AGENTS, prompt, or skill files', async () => {
    const root = await temporaryDirectory()
    const ambient = await temporaryDirectory('forage-ambient-')
    const ambientExtension = path.join(ambient, '.forage', 'extensions', 'ambient')
    await writeExtension(ambientExtension, manifest({ id: 'dev.example.ambient', name: 'Ambient' }))
    await mkdir(path.join(ambient, '.pi', 'extensions'), { recursive: true })
    await mkdir(path.join(ambient, 'prompts'), { recursive: true })
    await mkdir(path.join(ambient, 'skills'), { recursive: true })
    await writeFile(path.join(ambient, 'AGENTS.md'), 'ambient instructions', 'utf8')
    await writeFile(path.join(ambient, 'prompts', 'extension.md'), 'ambient prompt', 'utf8')
    await writeFile(path.join(ambient, 'skills', 'SKILL.md'), 'ambient skill', 'utf8')
    const originalWorkingDirectory = process.cwd()
    process.chdir(ambient)
    try {
      const catalog = await inventoryExtensions({ configurationRoot: root })
      expect(catalog.entries).toEqual([])
      expect(await readFile(path.join(ambientExtension, 'forage.extension.json'), 'utf8')).toContain('dev.example.ambient')
    } finally {
      process.chdir(originalWorkingDirectory)
    }
  })
})
