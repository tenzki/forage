import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  defineExtension,
  type ExtensionManifest,
  type ExtensionSkillExecutorDefinition,
  type ExtensionToolDefinition,
  type ForageExtensionHost,
  type ForageExtensionSetup,
} from '../src/index'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('@forage/extension-api', () => {
  it('defines one current native manifest contract with ordinary package release metadata', () => {
    const manifest = {
      id: 'dev.example.extension',
      name: 'Example',
      version: '1.0.0',
      description: 'Example extension.',
      entry: './dist/index.js',
      contributes: {
        tools: [],
        hooks: ['run:start'],
        settings: [{ key: 'token', label: 'Token', type: 'secret', required: true }],
        executors: [],
      },
    } as const satisfies ExtensionManifest

    expect(manifest.id).toBe('dev.example.extension')
    expect(manifest.version).toBe('1.0.0')
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
      registerSkillExecutor() {},
      on(event) {
        events.push(event)
      },
    })

    expect(tools.map((tool) => tool.id)).toEqual(['example_tool'])
    expect(events).toEqual(['run:start', 'run:end'])
  })

  it('supports a deterministic non-evaluation executor without an LLM or editor dependency', async () => {
    const executors: ExtensionSkillExecutorDefinition[] = []
    const extension = defineExtension((host) => {
      host.registerSkillExecutor({
        id: 'fixture',
        name: 'Uppercase fixture',
        description: 'Selects notes and returns their labels.',
        configuration: { fields: [{ key: 'prefix', label: 'Prefix', type: 'text' }] },
        async validateConfiguration() { return { valid: true } },
        async prepare(input) {
          const selectedNodeIds = input.context.roots.map((node) => node.id)
          return { selectedNodeIds, requestedReferenceIds: selectedNodeIds, annotations: [], data: {} }
        },
        async execute(input, context) {
          context.signal.throwIfAborted()
          context.reportProgress({ message: 'Formatted', completed: 1, total: 1 })
          return {
            nodes: input.plan.selectedNodeIds.map((nodeId) => ({
              type: 'text',
              segments: [{ type: 'internal-reference', nodeId, label: nodeId.toUpperCase() }],
            })),
          }
        },
      })
    })
    await extension({
      registerTool() {},
      registerSkillExecutor(executor) { executors.push(executor) },
      on() {},
    })
    expect(executors.map((executor) => executor.id)).toEqual(['fixture'])
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
