import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const transport = vi.hoisted(() => ({
  fetch: vi.fn(),
}))

vi.mock('undici', () => ({ fetch: transport.fetch }))

import { createWebFetchTool } from './tools'

describe('sidecar web_fetch', () => {
  beforeEach(() => {
    transport.fetch.mockReset()
    transport.fetch.mockResolvedValue(new Response([
      'Title: Example Domain',
      '',
      'Markdown Content:',
      'Readable webpage content.',
    ].join('\n'), { status: 200 }))
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('\u001bd\u000f\u0000���compressed bytes', { status: 200 }),
    ))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns readable webpage content through the matching Undici transport', async () => {
    const result = await createWebFetchTool().execute('fetch-1', {
      url: 'https://example.com/article',
    }, undefined, undefined, {} as never)
    const content = result.content[0]

    expect(content.type).toBe('text')
    if (content.type !== 'text') throw new Error('Expected a text tool result.')
    expect(content.text).toContain('Readable webpage content.')
    expect(content.text).not.toContain('�')
  })
})
