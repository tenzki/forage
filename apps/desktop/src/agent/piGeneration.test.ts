import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SKILLS } from './skills'

type TestEvent = Record<string, unknown> & { type: string }

const rpc = vi.hoisted(() => ({
  listener: undefined as ((event: TestEvent) => void) | undefined,
  promptEvents: [] as TestEvent[],
  promptEventBatches: [] as TestEvent[][],
  promptCount: 0,
  emitDefaultText: true,
  start: vi.fn(async () => undefined),
  stop: vi.fn(async () => undefined),
}))

vi.mock('./piSdkClient', () => ({
  PiRpcClient: class {
    onEvent(listener: (event: TestEvent) => void) {
      rpc.listener = listener
      return () => { rpc.listener = undefined }
    }

    start = rpc.start
    stop = rpc.stop
    abort = vi.fn(async () => undefined)
    waitForSettled = vi.fn(async () => undefined)
    getStderr = () => ''

    async prompt() {
      const events = rpc.promptEventBatches[rpc.promptCount] ?? rpc.promptEvents
      rpc.promptCount += 1
      for (const event of events) rpc.listener?.(event)
      if (rpc.emitDefaultText) {
        rpc.listener?.({
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', delta: 'done' },
        })
      }
    }
  },
}))

import { generateWithPi } from './piGeneration'

beforeEach(() => {
  vi.clearAllMocks()
  rpc.listener = undefined
  rpc.promptEvents = []
  rpc.promptEventBatches = []
  rpc.promptCount = 0
  rpc.emitDefaultText = true
})

describe('generateWithPi authentication', () => {
  it('forwards validated OAuth metadata to the sidecar client', async () => {
    const expires = Date.now() + 15 * 60_000

    await generateWithPi({
      mode: 'subscription',
      apiKey: '',
      modelId: 'gpt-test',
      oauthCredential: {
        type: 'oauth',
        access: 'access-token',
        refresh: 'refresh-token',
        expires,
        accountId: 'account-id',
      },
    }, {
      skill: SKILLS[0],
      prompt: 'test',
      context: [],
      enabledToolIds: [],
    }, { onDelta: vi.fn() })

    expect(rpc.start).toHaveBeenCalledWith({
      provider: 'openai-codex',
      modelId: 'gpt-test',
      apiKey: 'access-token',
      accountId: 'account-id',
      oauthExpires: expires,
    })
  })
})

describe('generateWithPi activity', () => {
  it('retries once when Pi settles without text or an outline', async () => {
    const onOutline = vi.fn()
    rpc.emitDefaultText = false
    rpc.promptEventBatches = [
      [{ type: 'agent_settled' }],
      [{
        type: 'tool_execution_end',
        toolName: 'emit_outline',
        result: { details: { action: 'emit_outline', nodes: [{ text: 'Recovered response' }] } },
      }],
    ]

    await generateWithPi({
      mode: 'api_key', apiKey: 'test-key', oauthCredential: null, modelId: 'gpt-test',
    }, {
      skill: SKILLS[0], prompt: 'test', context: [], enabledToolIds: [],
    }, { onDelta: vi.fn(), onOutline })

    expect(rpc.promptCount).toBe(2)
    expect(onOutline).toHaveBeenCalledWith([{ text: 'Recovered response' }])
  })

  it('stops after one recovery attempt when Pi keeps returning empty', async () => {
    rpc.emitDefaultText = false
    rpc.promptEvents = [{ type: 'agent_settled' }]

    await expect(generateWithPi({
      mode: 'api_key', apiKey: 'test-key', oauthCredential: null, modelId: 'gpt-test',
    }, {
      skill: SKILLS[0], prompt: 'test', context: [], enabledToolIds: [],
    }, { onDelta: vi.fn() })).rejects.toThrow('The agent finished without producing a response after one retry.')

    expect(rpc.promptCount).toBe(2)
  })

  it('uses final settled text when the provider emitted no streaming deltas or outline tool result', async () => {
    const onDelta = vi.fn()
    rpc.emitDefaultText = false
    rpc.promptEvents = [{ type: 'agent_settled', text: 'Fallback response' }]

    const result = await generateWithPi({
      mode: 'api_key',
      apiKey: 'test-key',
      oauthCredential: null,
      modelId: 'gpt-test',
    }, {
      skill: SKILLS[0],
      prompt: 'test',
      context: [],
      enabledToolIds: [],
    }, { onDelta })

    expect(result).toBe('Fallback response')
    expect(onDelta).toHaveBeenCalledWith('Fallback response')
  })

  it('does not duplicate settled text after a streamed response', async () => {
    const onDelta = vi.fn()
    rpc.emitDefaultText = false
    rpc.promptEvents = [
      { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Streamed response' } },
      { type: 'agent_settled', text: 'Final response' },
    ]

    const result = await generateWithPi({
      mode: 'api_key', apiKey: 'test-key', oauthCredential: null, modelId: 'gpt-test',
    }, {
      skill: SKILLS[0], prompt: 'test', context: [], enabledToolIds: [],
    }, { onDelta })

    expect(result).toBe('Streamed response')
    expect(onDelta).toHaveBeenCalledTimes(1)
  })

  it('does not use settled text after an outline tool result', async () => {
    const onDelta = vi.fn()
    const onOutline = vi.fn()
    rpc.emitDefaultText = false
    rpc.promptEvents = [
      {
        type: 'tool_execution_end',
        toolName: 'emit_outline',
        result: { details: { action: 'emit_outline', nodes: [{ text: 'Structured response' }] } },
      },
      { type: 'agent_settled', text: 'Fallback response' },
    ]

    await generateWithPi({
      mode: 'api_key', apiKey: 'test-key', oauthCredential: null, modelId: 'gpt-test',
    }, {
      skill: SKILLS[0], prompt: 'test', context: [], enabledToolIds: [],
    }, { onDelta, onOutline })

    expect(onOutline).toHaveBeenCalledWith([{ text: 'Structured response' }])
    expect(onDelta).not.toHaveBeenCalled()
  })

  it('keeps tool arguments in the completed activity event', async () => {
    const onActivity = vi.fn()
    rpc.promptEvents = [
      {
        type: 'tool_execution_start',
        toolCallId: 'fetch-1',
        toolName: 'web_fetch',
        args: { url: 'https://example.com/article' },
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'fetch-1',
        toolName: 'web_fetch',
        result: { content: [{ type: 'text', text: 'Long page body' }] },
        isError: false,
      },
    ]

    await generateWithPi({
      mode: 'api_key',
      apiKey: 'test-key',
      oauthCredential: null,
      modelId: 'gpt-test',
    }, {
      skill: SKILLS[0],
      agent: { id: 'agent', name: 'Agent', description: '', systemPrompt: '', modelId: '', toolIds: ['web_fetch'] },
      prompt: 'test',
      context: [],
      enabledToolIds: ['web_fetch'],
    }, { onDelta: vi.fn(), onActivity })

    expect(onActivity).toHaveBeenCalledWith(expect.objectContaining({
      id: 'tool-fetch-1',
      phase: 'complete',
      detail: 'url: https://example.com/article · Completed',
    }))
  })

  it('replaces inline node activity with the latest tool action', async () => {
    const onToolActivity = vi.fn()
    rpc.promptEvents = [
      {
        type: 'tool_execution_start',
        toolCallId: 'search-1',
        toolName: 'web_search',
        args: { query: 'first query' },
      },
      {
        type: 'tool_execution_start',
        toolCallId: 'fetch-1',
        toolName: 'web_fetch',
        args: { url: 'https://example.com/latest' },
      },
    ]

    await generateWithPi({
      mode: 'api_key',
      apiKey: 'test-key',
      oauthCredential: null,
      modelId: 'gpt-test',
    }, {
      skill: SKILLS[0],
      agent: { id: 'agent', name: 'Agent', description: '', systemPrompt: '', modelId: '', toolIds: ['web_search', 'web_fetch'] },
      prompt: 'test',
      context: [],
      enabledToolIds: ['web_search', 'web_fetch'],
    }, { onDelta: vi.fn(), onToolActivity })

    expect(onToolActivity.mock.calls).toEqual([
      [['web_search: query: first query']],
      [['web_fetch: url: https://example.com/latest']],
    ])
  })
})
