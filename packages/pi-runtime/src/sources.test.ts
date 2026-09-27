import { describe, expect, it } from 'vitest'
import { createEmitOutlineTool } from './emit-outline'
import { VerifiedSources } from './sources'

describe('result source filtering', () => {
  it('keeps only sources a source-reading tool returned in this run, ignoring URL fragments', () => {
    const sources = new VerifiedSources()
    sources.register('https://example.com/read#top')

    expect(sources.filter([
      { url: 'https://example.com/read', label: 'Read' },
      { url: 'https://example.com/read#later', label: 'Same page' },
      { url: 'https://example.com/lead', label: 'Search lead' },
    ])).toEqual([
      { url: 'https://example.com/read', label: 'Read' },
      { url: 'https://example.com/read#later', label: 'Same page' },
    ])
  })

  it('drops unread sources from the emitted outline and resolves generated images', async () => {
    const sources = new VerifiedSources()
    sources.register('https://example.com/read')
    const imageId = `img_${'a'.repeat(32)}`
    const images = new Map([[imageId, { src: 'data:image/png;base64,AAAA', prompt: 'A tide chart' }]])
    const result = await createEmitOutlineTool(images, sources).execute('call-1', {
      nodes: [{ text: 'Tides', children: [{ text: 'Moon' }] }, { imageId }],
      sources: [
        { url: 'https://example.com/read', label: 'Read' },
        { url: 'https://example.com/lead', label: 'Lead' },
      ],
    }, undefined, undefined, {} as never)

    expect(result.terminate).toBe(true)
    expect(result.details).toEqual({
      action: 'emit_outline',
      nodes: [
        { text: 'Tides', children: [{ text: 'Moon' }] },
        { type: 'image', image: { src: 'data:image/png;base64,AAAA', alt: 'A tide chart' } },
      ],
      sources: [{ url: 'https://example.com/read', label: 'Read' }],
    })
  })

  it('rejects references to images this turn did not generate', async () => {
    await expect(createEmitOutlineTool(new Map(), new VerifiedSources()).execute('call-1', {
      nodes: [{ imageId: `img_${'b'.repeat(32)}` }],
    }, undefined, undefined, {} as never)).rejects.toThrow(/unknown generated image/)
  })
})
