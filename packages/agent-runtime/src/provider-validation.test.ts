import { afterEach, describe, expect, it, vi } from 'vitest'
import { validateProviderConnection } from './provider-validation'

const fixtures = [
  { provider: 'anthropic', url: 'https://api.anthropic.com/v1/models?limit=1', body: { data: [{ id: 'claude' }] } },
  { provider: 'openrouter', url: 'https://openrouter.ai/api/v1/key', body: { data: { label: 'key', limit: null } } },
  { provider: 'opencode-go', url: 'https://opencode.ai/zen/go/v1/usage', body: { usage: { rolling: {}, weekly: {}, monthly: {} } } },
  { provider: 'openai', url: 'https://api.openai.com/v1/models', body: { data: [{ id: 'gpt-5' }] } },
] as const
const secret = 'sk-private-connection-test-secret'

afterEach(() => vi.useRealTimers())

describe('bounded provider connection checks', () => {
  it.each(fixtures)('verifies $provider without a billable model request', async ({ provider, url, body }) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify(body)))
    await expect(validateProviderConnection(provider, secret, { fetch })).resolves.toBeUndefined()
    expect(fetch).toHaveBeenCalledOnce()
    expect(fetch.mock.calls[0]?.[0]).toBe(url)
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', redirect: 'error', signal: expect.any(AbortSignal) })
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject(provider === 'anthropic' ? { 'x-api-key': secret, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${secret}` })
  })

  it.each([401, 403, 429, 503])('sanitizes HTTP %s failures', async (status) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(secret, { status }))
    const failure = await validateProviderConnection('opencode-go', secret, { fetch }).catch((error: Error) => error)
    expect(failure).toBeInstanceOf(Error)
    expect(String(failure)).not.toContain(secret)
    expect(failure).toHaveProperty('code', status === 401 ? 'authentication_required' : status === 403 ? 'provider_rejected' : 'dependency_unavailable')
  })

  it.each(['not json', '{}', '{"error":"secret"}', JSON.stringify({ data: ['x'.repeat(100_000)] })])('rejects malformed or oversized success bodies', async (body) => {
    await expect(validateProviderConnection('openai', secret, { fetch: async () => new Response(body) })).rejects.toThrow()
  })

  it('sanitizes network errors containing credentials', async () => {
    await expect(validateProviderConnection('openai', secret, { fetch: async () => { throw new Error(secret) } })).rejects.toThrow('Could not verify provider connectivity')
  })

  it('times out even when fetch ignores cancellation', async () => {
    vi.useFakeTimers()
    const checking = validateProviderConnection('openai', secret, { fetch: () => new Promise(() => {}), timeoutMs: 10 })
    const rejected = expect(checking).rejects.toHaveProperty('code', 'timeout')
    await vi.advanceTimersByTimeAsync(10)
    await rejected
  })

  it('cancels an in-flight request and never starts a pre-cancelled request', async () => {
    const controller = new AbortController()
    const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise(() => {}))
    const checking = validateProviderConnection('openai', secret, { fetch, signal: controller.signal })
    controller.abort()
    await expect(checking).rejects.toHaveProperty('name', 'AbortError')
    fetch.mockClear()
    await expect(validateProviderConnection('openai', secret, { fetch, signal: controller.signal })).rejects.toHaveProperty('name', 'AbortError')
    expect(fetch).not.toHaveBeenCalled()
  })
})
