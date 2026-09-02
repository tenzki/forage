// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { SupadataTranscriptProvider } from './transcript'

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('Supadata transcript provider', () => {
  it('returns an immediate bounded transcript with language metadata', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response(200, { content: [{ text: 'Hello' }, { text: 'world' }], lang: 'en' }))
    const provider = new SupadataTranscriptProvider({ apiUrl: 'https://transcripts.example/v1', apiKey: 'secret', fetch })
    await expect(provider.transcript({ videoId: 'abc123', canonicalUrl: 'https://www.youtube.com/watch?v=abc123' }, new AbortController().signal))
      .resolves.toEqual({ text: 'Hello\nworld', language: 'en' })
    expect(fetch.mock.calls[0]?.[1]?.headers).toEqual({ 'x-api-key': 'secret' })
  })

  it('polls asynchronous jobs within a deadline', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(response(202, { jobId: 'job-1' }))
      .mockResolvedValueOnce(response(200, { status: 'processing' }))
      .mockResolvedValueOnce(response(200, { status: 'completed', transcript: 'Done', language: 'sr' }))
    const provider = new SupadataTranscriptProvider({
      apiUrl: 'https://transcripts.example/v1', apiKey: 'secret', fetch,
      pollIntervalMs: 1, deadlineMs: 1_000,
    })
    await expect(provider.transcript({ videoId: 'abc123', canonicalUrl: 'https://www.youtube.com/watch?v=abc123' }, new AbortController().signal))
      .resolves.toEqual({ text: 'Done', language: 'sr' })
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('classifies unavailable, rate-limited, oversized, timeout, and cancellation without leaking secrets', async () => {
    const unavailable = new SupadataTranscriptProvider({ apiUrl: 'https://example.com', apiKey: 'secret-key', fetch: async () => response(404, { error: 'secret-key no transcript' }) })
    await expect(unavailable.transcript({ videoId: 'abc123', canonicalUrl: 'https://youtube.com/watch?v=abc123' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'transcript_unavailable', retryable: false })

    const limited = new SupadataTranscriptProvider({ apiUrl: 'https://example.com', apiKey: 'secret-key', fetch: async () => response(429, { error: 'secret-key limited' }) })
    await expect(limited.transcript({ videoId: 'abc123', canonicalUrl: 'https://youtube.com/watch?v=abc123' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'provider_rate_limited', retryable: true })

    const oversized = new SupadataTranscriptProvider({ apiUrl: 'https://example.com', apiKey: 'secret', fetch: async () => response(200, { transcript: 'x'.repeat(100_001) }) })
    await expect(oversized.transcript({ videoId: 'abc123', canonicalUrl: 'https://youtube.com/watch?v=abc123' }, new AbortController().signal)).rejects.toThrow(/100000/)

    const timeout = new SupadataTranscriptProvider({ apiUrl: 'https://example.com', apiKey: 'secret', fetch: async () => response(202, { jobId: 'job' }), pollIntervalMs: 1, deadlineMs: 0 })
    await expect(timeout.transcript({ videoId: 'abc123', canonicalUrl: 'https://youtube.com/watch?v=abc123' }, new AbortController().signal))
      .rejects.toMatchObject({ code: 'timeout', retryable: true })

    const controller = new AbortController(); controller.abort()
    await expect(limited.transcript({ videoId: 'abc123', canonicalUrl: 'https://youtube.com/watch?v=abc123' }, controller.signal)).rejects.toHaveProperty('name', 'AbortError')
  })
})
