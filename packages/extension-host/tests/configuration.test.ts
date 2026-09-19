import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { extensionConfigurationSchema } from '@forage/agent-runtime'
import {
  ExtensionConfigurationStore,
  createExtensionSecretReference,
} from '../src/configuration'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'forage-extension-config-'))
  temporaryDirectories.push(directory)
  return directory
}

describe('ExtensionConfigurationStore', () => {
  it('resolves relative local paths against .forage and deduplicates canonical paths', async () => {
    const root = await temporaryDirectory()
    const extensionDirectory = path.join(root, 'projects', 'weather')
    await mkdir(extensionDirectory, { recursive: true })
    await symlink(extensionDirectory, path.join(root, 'weather-link'))
    let sequence = 0
    const store = new ExtensionConfigurationStore({
      root,
      createInstallationId: () => `installation-${++sequence}`,
    })

    const first = await store.registerLocalSource('projects/weather')
    const duplicate = await store.registerLocalSource(path.join(root, 'weather-link'))

    expect(first.created).toBe(true)
    expect(duplicate.created).toBe(false)
    expect(duplicate.installationId).toBe(first.installationId)
    expect(duplicate.configuration.sources).toHaveLength(1)
    expect(duplicate.canonicalPath).toBe(first.canonicalPath)
    expect(JSON.parse(await readFile(store.settingsPath, 'utf8'))).toMatchObject({ version: 1, revision: 2 })
  })

  it('preserves a malformed settings file and refuses to overwrite it', async () => {
    const root = await temporaryDirectory()
    const store = new ExtensionConfigurationStore({ root })
    await mkdir(root, { recursive: true })
    await writeFile(store.settingsPath, '{not valid json', 'utf8')

    await expect(store.mutate(() => undefined)).rejects.toMatchObject({
      code: 'invalid_configuration',
    })
    expect(await readFile(store.settingsPath, 'utf8')).toBe('{not valid json')
    expect(await readdir(root)).toEqual(['settings.json'])
  })

  it('serializes concurrent mutations across store instances and writes atomically', async () => {
    const root = await temporaryDirectory()
    const stores = Array.from({ length: 12 }, () => new ExtensionConfigurationStore({ root }))

    await Promise.all(stores.map((store, index) => store.mutate((draft) => {
      draft.sources.push({
        installationId: `installation-${index}`,
        source: { kind: 'local', path: `source-${index}` },
        enabled: false,
        trust: { accepted: false },
        settings: {},
      })
    })))

    const configuration = await stores[0].read()
    expect(configuration.revision).toBe(12)
    expect(configuration.sources).toHaveLength(12)
    expect((await readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })

  it('stores only scoped native secret references, never plaintext extension secrets', () => {
    const reference = createExtensionSecretReference('installation-1', 'api_token')
    const parsed = extensionConfigurationSchema.parse({
      version: 1,
      revision: 1,
      sources: [{
        installationId: 'installation-1',
        source: { kind: 'local', path: 'weather' },
        enabled: true,
        trust: { accepted: true, extensionId: 'dev.example.weather' },
        settings: { region: 'eu' },
        secretReferences: { api_token: reference },
      }],
    })
    expect(parsed.sources[0].secretReferences).toEqual({ api_token: 'forage-extension/installation-1/api_token' })
    expect(() => extensionConfigurationSchema.parse({
      ...parsed,
      sources: [{ ...parsed.sources[0], secrets: { api_token: 'plaintext' } }],
    })).toThrow()
    expect(() => extensionConfigurationSchema.parse({
      ...parsed,
      sources: [{
        ...parsed.sources[0],
        secretReferences: { api_token: 'forage-extension/another-installation/api_token' },
      }],
    })).toThrow(/scoped/i)
  })
})
