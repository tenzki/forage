import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SKILLS } from './skills'

type TestEvent = Record<string, unknown> & { type: string }

const rpc = vi.hoisted(() => ({
  listener: undefined as ((event: TestEvent) => void) | undefined,
  promptEvents: [] as TestEvent[],
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
      for (const event of rpc.promptEvents) rpc.listener?.(event)
      rpc.listener?.({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: 'done' },
      })
    }
  },
}))

import { generateWithPi } from './piGeneration'

beforeEach(() => {
  vi.clearAllMocks()
  rpc.listener = undefined
  rpc.promptEvents = []
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
