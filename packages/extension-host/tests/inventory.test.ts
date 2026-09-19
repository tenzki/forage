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
    $schema: 'https://forage.app/schemas/extension-manifest-v1.json',
    manifestVersion: 1,
    id: 'dev.example.weather',
    name: 'Weather',
    version: '1.0.0',
    description: 'Reports deterministic fixture weather.',
    entry: './dist/index.js',
    apiVersion: '1',
    contributes: {
      tools: [{ id: 'weather_lookup', name: 'Weather lookup', description: 'Look up weather.' }],
      hooks: [],
      settings: [],
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

  it('keeps future manifest and API versions inspectable but unavailable', async () => {
    const root = await temporaryDirectory()
    const extension = path.join(root, 'extensions', 'future')
    await writeExtension(extension, manifest({ manifestVersion: 2, apiVersion: '7' }))

    const [entry] = (await inventoryExtensions({ configurationRoot: root })).entries

    expect(entry.status).toBe('incompatible')
    expect(entry.manifest).toBeUndefined()
    expect(entry.inspection).toMatchObject({ manifestVersion: 2, apiVersion: '7', id: 'dev.example.weather' })
    expect(entry.tools).toEqual([expect.objectContaining({ id: 'weather_lookup', available: false })])
    expect(entry.diagnostics.map((item) => item.code)).toEqual([
      'incompatible_manifest_version',
      'incompatible_api_version',
    ])
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
