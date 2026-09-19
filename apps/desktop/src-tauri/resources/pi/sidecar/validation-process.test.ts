import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ExtensionConfiguration } from '@forage/agent-runtime'
import { inventoryExtensions } from '@forage/extension-host'
import { credentialFreeValidationEnvironment, validateEntryInProcess } from './validation-process'

const directories: string[] = []
afterEach(async () => {
  delete process.env.AI_CHAT_API_KEY
  delete process.env.FORAGE_EXTENSION_TEST_SECRET
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function fixture(sourceCode: string) {
  const root = await mkdtemp(path.join(tmpdir(), 'forage-validation-process-'))
  directories.push(root)
  const source = path.join(root, 'source')
  await mkdir(path.join(source, 'dist'), { recursive: true })
  await writeFile(path.join(source, 'forage.extension.json'), JSON.stringify({
    manifestVersion: 1, id: 'dev.example.process', name: 'Process', version: '1.0.0',
    description: 'Validation process fixture.', entry: './dist/index.mjs', apiVersion: '1',
    contributes: { tools: [], hooks: [], settings: [] },
  }))
  await writeFile(path.join(source, 'dist/index.mjs'), sourceCode)
  const configured = {
    installationId: 'installation-process', source: { kind: 'local' as const, path: source }, enabled: true,
    trust: { accepted: true as const, extensionId: 'dev.example.process' }, settings: {},
  }
  const configuration: ExtensionConfiguration = { version: 1, revision: 1, sources: [configured] }
  const catalog = await inventoryExtensions({ configurationRoot: root, configuration })
  return { entry: catalog.entries[0]!, configured }
}

describe('credential-free validation process', () => {
  it('does not inherit model credentials or extension secrets', async () => {
    process.env.AI_CHAT_API_KEY = 'model-secret'
    process.env.FORAGE_EXTENSION_TEST_SECRET = 'extension-secret'
    expect(credentialFreeValidationEnvironment()).not.toHaveProperty('AI_CHAT_API_KEY')
    expect(credentialFreeValidationEnvironment()).not.toHaveProperty('FORAGE_EXTENSION_TEST_SECRET')
    const value = await fixture(`
      export default () => {
        if (process.env.AI_CHAT_API_KEY || process.env.FORAGE_EXTENSION_TEST_SECRET) throw new Error('secret leaked')
      }
    `)
    await expect(validateEntryInProcess(value.entry, value.configured, new AbortController().signal)).resolves.toEqual([])
  })

  it('terminates a blocked validation process after cancellation', async () => {
    const value = await fixture('export default async () => new Promise(() => {})')
    const controller = new AbortController()
    const validation = validateEntryInProcess(value.entry, value.configured, controller.signal)
    setTimeout(() => controller.abort(), 25)
    await expect(validation).resolves.toEqual([
      expect.objectContaining({ code: 'validation_cancelled' }),
    ])
  })
})
