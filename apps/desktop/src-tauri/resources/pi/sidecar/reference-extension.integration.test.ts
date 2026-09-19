import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { ExtensionConfiguration } from '@forage/agent-runtime'
import {
  createLocalExtensionSnapshot,
  inventoryExtensions,
  loadForageExtension,
  runExtensionEndHooks,
  runExtensionStartHooks,
  validateForageExtensionEntry,
  verifyLocalExtensionSnapshot,
} from '@forage/extension-host'
import { adaptExtensionTools } from './extension-tools'

const referenceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../../packages/extensions',
)

interface FakeActivity {
  type: 'start' | 'progress' | 'end' | 'log'
  installationId: string
  extensionId: string
  toolName?: string
  detail?: unknown
}

describe('reference extension through the packaged sidecar adapter', () => {
  it('covers inventory, validation, policy, hooks, settings, activity, and structured execution with a fake model', async () => {
    const source = {
      installationId: 'reference-text-stats',
      source: { kind: 'local' as const, path: referenceRoot },
      enabled: true,
      trust: { accepted: true as const, extensionId: 'dev.forage.text-stats' },
      settings: { progress_message: 'Analyzing reference text' },
    }
    const configuration: ExtensionConfiguration = { version: 1, revision: 7, sources: [source] }
    const catalog = await inventoryExtensions({ configurationRoot: referenceRoot, configuration })
    const entry = catalog.entries[0]!

    expect(entry).toMatchObject({
      status: 'ready',
      manifest: {
        id: 'dev.forage.text-stats',
        entry: './dist/index.js',
        contributes: { hooks: ['run:start', 'run:end'] },
      },
    })
    expect(await validateForageExtensionEntry(entry, source)).toEqual({
      tools: ['text_stats'], hooks: ['run:end', 'run:start'], diagnostics: [],
    })

    const snapshot = createLocalExtensionSnapshot(catalog, configuration, ['text_stats'])
    expect(() => verifyLocalExtensionSnapshot(snapshot, catalog, configuration)).not.toThrow()
    const loaded = await loadForageExtension(entry, { configuration: source, cacheKey: entry.provenance!.entryDigest })
    const controller = new AbortController()
    const activity: FakeActivity[] = []
    const identity = { installationId: source.installationId, extensionId: entry.manifest!.id }
    const execution = {
      signal: controller.signal,
      onLog: (log: { message: string }) => activity.push({ type: 'log', ...identity, detail: log.message }),
    }

    await runExtensionStartHooks([loaded], 'run-reference', execution)
    expect(adaptExtensionTools([loaded], new Set(), { signal: controller.signal })).toEqual([])
    const [tool] = adaptExtensionTools([loaded], new Set(['text_stats']), {
      signal: controller.signal,
      onProgress: (installationId, extensionId, toolName, progress) => {
        activity.push({ type: 'progress', installationId, extensionId, toolName, detail: progress })
      },
      onLog: execution.onLog,
    })
    expect(tool).toBeDefined()

    // A deterministic fake model asks for one policy-authorized tool through the
    // same ToolDefinition boundary used by the embedded model SDK.
    activity.push({ type: 'start', ...identity, toolName: tool!.name, detail: { text: 'Hello, forage 👋' } })
    const result = await tool!.execute(
      'fake-call-1', { text: 'Hello, forage 👋' }, controller.signal, undefined, {} as never,
    )
    activity.push({ type: 'end', ...identity, toolName: tool!.name, detail: result.details })
    await runExtensionEndHooks([loaded], 'run-reference', 'completed', execution)

    expect(result).toMatchObject({
      content: [{ type: 'text', text: '{"words":3,"characters":15}' }],
      details: { extension: source.installationId, json: { words: 3, characters: 15 } },
    })
    expect(activity).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'log', detail: 'Text Stats started for run-reference' }),
      expect.objectContaining({
        type: 'progress', installationId: source.installationId, extensionId: entry.manifest!.id,
        toolName: 'text_stats', detail: { message: 'Analyzing reference text', completed: 0, total: 1 },
      }),
      expect.objectContaining({ type: 'end', detail: { extension: source.installationId, json: { words: 3, characters: 15 } } }),
      expect.objectContaining({ type: 'log', detail: 'Text Stats completed for run-reference' }),
    ]))
  })

  it('propagates cancellation through the model adapter into the reference tool', async () => {
    const source = {
      installationId: 'reference-cancel', source: { kind: 'local' as const, path: referenceRoot }, enabled: true,
      trust: { accepted: true as const, extensionId: 'dev.forage.text-stats' }, settings: {},
    }
    const configuration: ExtensionConfiguration = { version: 1, revision: 1, sources: [source] }
    const catalog = await inventoryExtensions({ configurationRoot: referenceRoot, configuration })
    const loaded = await loadForageExtension(catalog.entries[0]!, { configuration: source })
    const controller = new AbortController()
    const [tool] = adaptExtensionTools([loaded], new Set(['text_stats']), { signal: controller.signal })
    controller.abort(new Error('cancelled by fake model'))

    await expect(tool!.execute(
      'fake-call-cancelled', { text: 'do not count' }, undefined, undefined, {} as never,
    )).rejects.toThrow(/cancelled by fake model/i)
  })
})
