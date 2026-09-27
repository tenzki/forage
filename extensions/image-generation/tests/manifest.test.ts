import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { inventoryExtensions, validateForageExtensionEntry } from '@forage/extension-host'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('image extension packaging', () => {
  it('inventories and validates the compiled package with normal extension trust', async () => {
    const source = {
      installationId: 'images', source: { kind: 'local' as const, path: root }, enabled: true,
      trust: { accepted: true as const, extensionId: 'dev.forage.image-generation' }, settings: {},
    }
    const catalog = await inventoryExtensions({ configurationRoot: root, configuration: { version: 1, revision: 1, sources: [source] } })
    const entry = catalog.entries[0]!
    expect(entry.status).toBe('ready')
    expect(await validateForageExtensionEntry(entry, source)).toEqual({
      tools: ['generate_image'], executors: [], hooks: ['run:start'], diagnostics: [],
    })
  })
})
