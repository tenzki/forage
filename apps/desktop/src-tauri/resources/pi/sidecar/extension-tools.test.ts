import { describe, expect, it, vi } from 'vitest'
import type { LoadedForageExtension } from '@forage/extension-host'
import { adaptExtensionTools } from './extension-tools'

describe('pinned Pi extension adapter', () => {
  it('adapts native tools without passing Pi engine objects into the extension API', async () => {
    const executeTool = vi.fn(async (_toolId, input, options) => {
      options.onProgress?.({ message: 'halfway', completed: 1, total: 2 })
      return { json: { input } } as const
    })
    const loaded = {
      entry: {
        source: { installationId: 'installation-1' },
        manifest: { id: 'dev.example.native' },
      },
      tools: new Map([['native_tool', {
        id: 'native_tool', name: 'Native tool', description: 'Native tool.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      }]]),
      executeTool,
    } as unknown as LoadedForageExtension
    const progress = vi.fn()
    const [adapted] = adaptExtensionTools([loaded], new Set(['native_tool']), {
      signal: new AbortController().signal,
      onProgress: progress,
    })
    const result = await adapted!.execute('call-1', { value: 1 }, undefined, undefined, {} as never)

    expect(executeTool).toHaveBeenCalledWith('native_tool', { value: 1 }, expect.objectContaining({ signal: expect.any(AbortSignal) }))
    expect(Object.keys(executeTool.mock.calls[0]![2])).not.toContain('session')
    expect(progress).toHaveBeenCalledWith('installation-1', 'dev.example.native', 'native_tool', { message: 'halfway', completed: 1, total: 2 })
    expect(result).toMatchObject({ details: { extension: 'installation-1', json: { input: { value: 1 } } } })
  })

  it('does not adapt unauthorized extension tools', () => {
    const loaded = {
      entry: { source: { installationId: 'installation-1' } },
      tools: new Map([['native_tool', { id: 'native_tool' }]]),
    } as unknown as LoadedForageExtension
    expect(adaptExtensionTools([loaded], new Set(), { signal: new AbortController().signal })).toEqual([])
  })
})
