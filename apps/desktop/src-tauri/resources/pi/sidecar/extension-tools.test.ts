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

describe('generic extension raster results', () => {
  const base64 = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]).toString('base64')
  function extension(result: unknown): LoadedForageExtension {
    return {
      entry: { source: { installationId: 'images' }, manifest: { id: 'dev.example.images' } },
      tools: new Map([['draw', { id: 'draw', name: 'Draw', description: 'Draw.', inputSchema: {} }]]),
      executeTool: vi.fn(async () => result),
    } as unknown as LoadedForageExtension
  }

  it('keeps bytes out of model results and materializes the same image through emit_outline', async () => {
    const { createEmitOutlineTool, VerifiedSources } = await import('@forage/pi-runtime')
    const images = new Map<string, { src: string; prompt: string }>()
    const [tool] = adaptExtensionTools([extension({ image: { mediaType: 'image/png', base64, alt: 'An otter' } })], new Set(['draw']), {
      signal: new AbortController().signal, images,
    })
    const result = await tool.execute('draw-1', {}, undefined, undefined, {} as never)
    expect(JSON.stringify(result)).not.toContain(base64)
    const imageId = [...images.keys()][0]
    expect(imageId).toMatch(/^img_[a-f0-9]{32}$/)
    const emitted = await createEmitOutlineTool(images, new VerifiedSources()).execute('emit-1', { nodes: [{ imageId }] }, undefined, undefined, {} as never)
    expect(emitted.details).toMatchObject({ nodes: [{ type: 'image', image: { src: `data:image/png;base64,${base64}`, alt: 'An otter' } }] })
    await expect(tool.execute('draw-2', {}, undefined, undefined, {} as never)).rejects.toThrow('At most one')
  })

  it.each([
    { mediaType: 'image/svg+xml', base64, alt: 'SVG' },
    { mediaType: 'image/webp', base64, alt: 'Wrong signature' },
    { mediaType: 'image/png', base64: 'not base64', alt: 'Invalid bytes' },
    { mediaType: 'image/png', base64: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64'), alt: 'Too large' },
  ])('rejects invalid images before storing them', async (image) => {
    const images = new Map()
    const [tool] = adaptExtensionTools([extension({ image })], new Set(['draw']), { signal: new AbortController().signal, images })
    await expect(tool.execute('draw-1', {}, undefined, undefined, {} as never)).rejects.toThrow()
    expect(images.size).toBe(0)
  })

  it('does not retain an image returned after cancellation', async () => {
    const controller = new AbortController()
    const loaded = extension({ image: { mediaType: 'image/png', base64, alt: 'Otter' } })
    vi.mocked(loaded.executeTool).mockImplementation(async () => {
      controller.abort()
      return { image: { mediaType: 'image/png', base64, alt: 'Otter' } }
    })
    const images = new Map()
    const [tool] = adaptExtensionTools([loaded], new Set(['draw']), { signal: controller.signal, images })
    await expect(tool.execute('draw-1', {}, undefined, undefined, {} as never)).rejects.toThrow()
    expect(images.size).toBe(0)
  })
})
