import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  defineExtension,
  FORAGE_EXTENSION_API_VERSION,
  FORAGE_EXTENSION_MANIFEST_SCHEMA,
  FORAGE_EXTENSION_MANIFEST_VERSION,
  type ExtensionManifest,
  type ExtensionToolDefinition,
  type ForageExtensionHost,
  type ForageExtensionSetup,
} from '../src/index'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('@forage/extension-api', () => {
  it('defines the native manifest and API version contract', () => {
    const manifest = {
      $schema: FORAGE_EXTENSION_MANIFEST_SCHEMA,
      manifestVersion: FORAGE_EXTENSION_MANIFEST_VERSION,
      id: 'dev.example.extension',
      name: 'Example',
      version: '1.0.0',
      description: 'Example extension.',
      entry: './dist/index.js',
      apiVersion: FORAGE_EXTENSION_API_VERSION,
      contributes: {
        tools: [],
        hooks: ['run:start'],
        settings: [{ key: 'token', label: 'Token', type: 'secret', required: true }],
      },
    } as const satisfies ExtensionManifest

    expect(manifest.manifestVersion).toBe(1)
    expect(manifest.apiVersion).toBe('1')
  })

  it('returns the exact setup function without wrapping or executing it', () => {
    let executions = 0
    const setup = (host: ForageExtensionHost) => {
      executions += 1
      expect(host).toBeDefined()
    }

    const extension = defineExtension(setup)

    expect(extension).toBe(setup)
    expect(executions).toBe(0)
  })

  it('supports typed tools, lifecycle hooks, progress, logging, and cancellation', async () => {
    const tools: ExtensionToolDefinition[] = []
    const events: string[] = []
    const extension: ForageExtensionSetup = defineExtension((host) => {
      host.registerTool({
        id: 'example_tool',
        name: 'Example tool',
        description: 'Exercises the public contract.',
        inputSchema: { type: 'object' },
        async execute(_input, context) {
          context.signal.throwIfAborted()
          context.reportProgress({ message: 'Done', completed: 1, total: 1 })
          context.log({ level: 'info', message: 'Finished' })
          return { json: { complete: true } }
        },
      })
      host.on('run:start', ({ runId }) => { events.push(runId) })
      host.on('run:end', ({ outcome }) => { events.push(outcome) })
    })

    await extension({
      registerTool(tool) {
        tools.push(tool)
      },
      on(event) {
        events.push(event)
      },
    })

    expect(tools.map((tool) => tool.id)).toEqual(['example_tool'])
    expect(events).toEqual(['run:start', 'run:end'])
  })

  it('does not depend on application frameworks or the embedded engine', () => {
    const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    expect(manifest.dependencies ?? {}).toEqual({})

    const source = readFileSync(path.join(packageRoot, 'src/index.ts'), 'utf8')
    for (const forbidden of ['@earendil-works', 'react', '@tauri-apps', '@forage/desktop', '@forage/server']) {
      expect(source).not.toContain(forbidden)
    }
  })
})
