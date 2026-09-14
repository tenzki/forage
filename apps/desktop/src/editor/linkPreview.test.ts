import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensurePreview, parseReaderResponse, readPreview, resetPreviewCache } from './linkPreview'

const fetchMock = vi.fn()
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: (...args: unknown[]) => fetchMock(...args) }))

function reader(body: string) {
  return { ok: true, status: 200, text: () => Promise.resolve(body) }
}

const SAMPLE = [
  'Title: Introducing GPT Image 2',
  'URL Source: https://example.com/post',
  '',
  'Markdown Content:',
  '# Introducing GPT Image 2',
  '![cover](https://example.com/cover.png)',
  '',
  'A new image model that follows instructions closely.',
].join('\n')

describe('parseReaderResponse', () => {
  it('takes the title header and the first prose line', () => {
    expect(parseReaderResponse(SAMPLE)).toEqual({
      title: 'Introducing GPT Image 2',
      description: 'A new image model that follows instructions closely.',
    })
  })

  it('returns nothing usable for an empty body', () => {
    expect(parseReaderResponse('')).toEqual({ title: undefined, description: undefined })
  })
})

describe('preview cache', () => {
  afterEach(() => {
    resetPreviewCache()
    fetchMock.mockReset()
  })

  it('fetches once for concurrent requests and caches the result', async () => {
    fetchMock.mockResolvedValue(reader(SAMPLE))

    const settled = vi.fn()
    expect(ensurePreview('https://example.com/post', settled).status).toBe('loading')
    ensurePreview('https://example.com/post')
    await vi.waitFor(() => expect(settled).toHaveBeenCalled())

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('https://r.jina.ai/https://example.com/post')
    expect(readPreview('https://example.com/post')).toEqual({
      status: 'ready',
      host: 'example.com',
      title: 'Introducing GPT Image 2',
      description: 'A new image model that follows instructions closely.',
    })

    ensurePreview('https://example.com/post')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('records an error state without throwing', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, text: () => Promise.resolve('') })
    const settled = vi.fn()
    ensurePreview('https://example.com/down', settled)
    await vi.waitFor(() => expect(settled).toHaveBeenCalled())
    expect(readPreview('https://example.com/down')).toEqual({ status: 'error', host: 'example.com' })
  })

  it('refuses private network hosts before fetching', async () => {
    const settled = vi.fn()
    ensurePreview('http://127.0.0.1:8080/admin', settled)
    await vi.waitFor(() => expect(settled).toHaveBeenCalled())
    expect(fetchMock).not.toHaveBeenCalled()
    expect(readPreview('http://127.0.0.1:8080/admin').status).toBe('error')
  })
})
