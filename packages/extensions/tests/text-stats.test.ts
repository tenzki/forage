import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type {
  ExtensionLogEntry,
  ExtensionProgress,
  ExtensionRunContext,
  ExtensionRunEndContext,
  ExtensionToolDefinition,
  ExtensionToolExecutionContext,
  ForageExtensionHost,
} from '@forage/extension-api'
import { describe, expect, it, vi } from 'vitest'
import setup, { TEXT_STATS_MAX_LENGTH } from '../src/index'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function loadReferenceExtension(): Promise<{
  tool: ExtensionToolDefinition
  start: (context: ExtensionRunContext) => void | Promise<void>
  end: (context: ExtensionRunEndContext) => void | Promise<void>
}> {
  const tools: ExtensionToolDefinition[] = []
  let start: ((context: ExtensionRunContext) => void | Promise<void>) | undefined
  let end: ((context: ExtensionRunEndContext) => void | Promise<void>) | undefined
  const host: ForageExtensionHost = {
    registerTool(tool) {
      tools.push(tool)
    },
    on(event, listener) {
      if (event === 'run:start') start = listener as typeof start
      else end = listener as typeof end
    },
  }
  await setup(host)
  expect(tools).toHaveLength(1)
  expect(start).toBeTypeOf('function')
  expect(end).toBeTypeOf('function')
  return { tool: tools[0]!, start: start!, end: end! }
}

async function loadTextStatsTool(): Promise<ExtensionToolDefinition> {
  return (await loadReferenceExtension()).tool
}

function createContext(signal: AbortSignal = new AbortController().signal): {
  context: ExtensionToolExecutionContext
  progress: ExtensionProgress[]
  logs: ExtensionLogEntry[]
} {
  const progress: ExtensionProgress[] = []
  const logs: ExtensionLogEntry[] = []
  return {
    context: {
      signal,
      settings: {},
      secrets: {},
      reportProgress(update) {
        progress.push(update)
      },
      log(entry) {
        logs.push(entry)
      },
    },
    progress,
    logs,
  }
}

describe('text_stats reference extension', () => {
  it('has a native v1 manifest matching its registered tool', async () => {
    const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'forage.extension.json'), 'utf8')) as {
      manifestVersion: number
      apiVersion: string
      entry: string
      contributes: { tools: Array<{ id: string }>; hooks: unknown[]; settings: unknown[] }
    }
    const { tool } = await loadReferenceExtension()

    expect(manifest).toMatchObject({ manifestVersion: 1, apiVersion: '1', entry: './dist/index.js' })
    expect(manifest.contributes.tools.map(({ id }) => id)).toEqual([tool.id])
    expect(manifest.contributes.hooks).toEqual(['run:start', 'run:end'])
    expect(manifest.contributes.settings).toEqual([
      expect.objectContaining({ key: 'progress_message', type: 'string', default: 'Counting text' }),
    ])
  })

  it.each([
    [{}, /only text/i],
    [{ text: 1 }, /must be a string/i],
    [{ text: 'hello', extra: true }, /only text/i],
    [null, /must be an object/i],
    [['hello'], /must be an object/i],
  ])('rejects invalid input %#', async (input, message) => {
    const tool = await loadTextStatsTool()
    const { context } = createContext()
    await expect(tool.execute(input, context)).rejects.toThrow(message)
  })

  it('defines empty and whitespace-only counting semantics', async () => {
    const tool = await loadTextStatsTool()
    const empty = createContext()
    const whitespace = createContext()

    await expect(tool.execute({ text: '' }, empty.context)).resolves.toEqual({
      json: { words: 0, characters: 0 },
    })
    await expect(tool.execute({ text: ' \n\t' }, whitespace.context)).resolves.toEqual({
      json: { words: 0, characters: 3 },
    })
  })

  it('counts whitespace-delimited words and Unicode code points deterministically', async () => {
    const tool = await loadTextStatsTool()
    const { context, progress, logs } = createContext()

    await expect(tool.execute({ text: 'Hello,  forage! 👋' }, context)).resolves.toEqual({
      json: { words: 3, characters: 17 },
    })
    expect(progress).toEqual([
      { message: 'Counting text', completed: 0, total: 1 },
      { message: 'Text counted', completed: 1, total: 1 },
    ])
    expect(logs).toEqual([])
  })

  it('uses declared settings and emits structured lifecycle logs', async () => {
    const { tool, start, end } = await loadReferenceExtension()
    const { context, progress } = createContext()
    const configuredContext = { ...context, settings: { progress_message: 'Analyzing text' } }
    const lifecycleLogs: ExtensionLogEntry[] = []
    const lifecycle = {
      runId: 'run-reference', signal: context.signal, settings: configuredContext.settings, secrets: {},
      log: (entry: ExtensionLogEntry) => lifecycleLogs.push(entry),
    }

    await start(lifecycle)
    await tool.execute({ text: 'configured progress' }, configuredContext)
    await end({ ...lifecycle, outcome: 'completed' })

    expect(progress[0]).toEqual({ message: 'Analyzing text', completed: 0, total: 1 })
    expect(lifecycleLogs).toEqual([
      { level: 'debug', message: 'Text Stats started for run-reference' },
      { level: 'debug', message: 'Text Stats completed for run-reference' },
    ])
  })

  it('accepts the declared bound and rejects larger input before reporting progress', async () => {
    const tool = await loadTextStatsTool()
    const bounded = createContext()
    const oversized = createContext()

    await expect(tool.execute({ text: 'a'.repeat(TEXT_STATS_MAX_LENGTH) }, bounded.context)).resolves.toEqual({
      json: { words: 1, characters: TEXT_STATS_MAX_LENGTH },
    })
    await expect(tool.execute({ text: '👋'.repeat(TEXT_STATS_MAX_LENGTH) }, createContext().context)).resolves.toEqual({
      json: { words: 1, characters: TEXT_STATS_MAX_LENGTH },
    })
    await expect(tool.execute({ text: 'a'.repeat(TEXT_STATS_MAX_LENGTH + 1) }, oversized.context))
      .rejects.toThrow(/must not exceed/i)
    expect(oversized.progress).toEqual([])
  })

  it('honors cancellation before doing work', async () => {
    const tool = await loadTextStatsTool()
    const controller = new AbortController()
    controller.abort(new Error('cancelled by test'))
    const { context, progress } = createContext(controller.signal)
    const result = tool.execute({ text: 'never counted' }, context)

    await expect(result).rejects.toThrow(/cancelled by test/i)
    expect(progress).toEqual([])
  })

  it('uses no network or model service', async () => {
    const tool = await loadTextStatsTool()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const { context } = createContext()

    await tool.execute({ text: 'local only' }, context)

    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})
