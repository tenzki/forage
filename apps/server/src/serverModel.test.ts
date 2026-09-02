// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { OpenAIResponsesDispatcherClassifier, OpenAIResponsesModelAdapter } from './serverModel'

describe('server OpenAI model adapter', () => {
  it('uses executor-owned API credentials and parses structured output', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({
      output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ version: 1, nodes: [{ type: 'text', text: 'Result' }], sources: [] }) }] }],
    }), { status: 200 }))
    const adapter = new OpenAIResponsesModelAdapter({
      credential: { provider: 'openai', apiKey: 'sk-secret-value' }, modelId: 'gpt-5', fetch,
    })
    await expect(adapter.invoke({ system: 'System', user: 'User', tools: [], history: [] }, new AbortController().signal))
      .resolves.toMatchObject({ type: 'structured_result', result: { version: 1 } })
    const request = fetch.mock.calls[0]?.[1]
    expect(request?.headers).toMatchObject({ authorization: 'Bearer sk-secret-value' })
    expect(JSON.stringify(request?.body)).not.toContain('sk-secret-value')
  })

  it('parses bounded function calls and emits sanitized upstream failures', async () => {
    const calls = new OpenAIResponsesModelAdapter({
      credential: { provider: 'openai-codex', accessToken: 'oauth-secret', accountId: 'account-1', expiresAt: '2030-01-01T00:00:00Z' },
      modelId: 'gpt-5', fetch: async () => new Response(JSON.stringify({ output: [{ type: 'function_call', call_id: 'call-1', name: 'web_read', arguments: '{"url":"https://example.com"}' }] }), { status: 200 }),
    })
    await expect(calls.invoke({ system: 'S', user: 'U', tools: [{ id: 'web_read', name: 'Read', description: 'Read' }], history: [] }, new AbortController().signal))
      .resolves.toMatchObject({ type: 'tool_calls', calls: [{ id: 'call-1', toolId: 'web_read' }] })

    const failed = new OpenAIResponsesModelAdapter({
      credential: { provider: 'openai', apiKey: 'sk-secret' }, modelId: 'gpt-5',
      fetch: async () => new Response('sk-secret internal details', { status: 500 }),
    })
    await expect(failed.invoke({ system: 'S', user: 'U', tools: [], history: [] }, new AbortController().signal)).rejects.toThrow('temporarily unavailable')
  })

  it('classifies dispatcher input with no tools and validates only configured skill ids', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({
      output_text: JSON.stringify({ skillIds: ['research', 'summarize'] }),
    }), { status: 200 }))
    const classifier = new OpenAIResponsesDispatcherClassifier({
      credential: { provider: 'openai', apiKey: 'sk-secret-value' }, modelId: 'gpt-5', fetch,
    })
    await expect(classifier.classify({
      text: 'An ambiguous link', source: { kind: 'share' }, allowedSkillIds: ['research', 'summarize'],
    }, new AbortController().signal)).resolves.toEqual(['research', 'summarize'])
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)) as { tools?: unknown[]; input?: unknown }
    expect(body.tools).toEqual([])
    expect(JSON.stringify(body)).not.toContain('sk-secret-value')
  })
})
