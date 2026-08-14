import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetch } from '@tauri-apps/plugin-http'
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
  Provider,
} from '@earendil-works/pi-ai'
import { generate } from './client'
import { WEB_SEARCH_TOOL_ID } from './tools'
import { SKILLS } from './skills'

const mocks = vi.hoisted(() => ({ streamSimple: vi.fn() }))

vi.mock('@earendil-works/pi-ai/providers/openai', () => ({
  openaiProvider: () => fakeProvider(),
}))
vi.mock('@earendil-works/pi-ai/providers/openai-codex', () => ({
  openaiCodexProvider: () => fakeProvider(),
}))
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }))

const model: Model<'openai-responses'> = {
  id: 'gpt-test-codex',
  name: 'GPT Test Codex',
  api: 'openai-responses',
  provider: 'openai',
  baseUrl: 'https://api.openai.com/v1',
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100_000,
  maxTokens: 4_096,
}

function fakeProvider(): Provider {
  return {
    id: 'openai',
    name: 'OpenAI',
    auth: {},
    getModels: () => [model],
    stream: mocks.streamSimple,
    streamSimple: mocks.streamSimple,
  }
}

function assistant(content: AssistantMessage['content']): AssistantMessage {
  return {
    role: 'assistant',
    content,
    api: 'openai-responses',
    provider: 'openai',
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: content.some((item) => item.type === 'toolCall') ? 'toolUse' : 'stop',
    timestamp: Date.now(),
  }
}

function eventStream(events: AssistantMessageEvent[]): AssistantMessageEventStream {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event
    },
  } as unknown as AssistantMessageEventStream
}

const mockedFetch = vi.mocked(fetch)

afterEach(() => {
  vi.clearAllMocks()
})

describe('Codex tool loop', () => {
  it('executes a requested tool and returns its result to the model', async () => {
    const toolCallMessage = assistant([{
      type: 'toolCall',
      id: 'call-1',
      name: WEB_SEARCH_TOOL_ID,
      arguments: { query: 'current outliner apps' },
    }])
    const finalMessage = assistant([{ type: 'text', text: 'Current finding' }])
    mocks.streamSimple
      .mockReturnValueOnce(eventStream([{
        type: 'done',
        reason: 'toolUse',
        message: toolCallMessage,
      }]))
      .mockReturnValueOnce(eventStream([
        {
          type: 'text_delta',
          contentIndex: 0,
          delta: 'Current finding',
          partial: finalMessage,
        },
        { type: 'done', reason: 'stop', message: finalMessage },
      ]))
    mockedFetch.mockResolvedValue(new Response(`
      <div class="result">
        <a class="result__a" href="https://example.com">Example</a>
        <a class="result__snippet">Recent information</a>
      </div>
    `, { status: 200 }))

    const deltas: string[] = []
    const activities: string[][] = []
    const result = await generate(
      {
        mode: 'api_key',
        apiKey: 'test-key',
        oauthCredential: null,
        modelId: model.id,
      },
      {
        skill: SKILLS[0],
        prompt: 'Find current outliner apps',
        context: [],
        enabledToolIds: [WEB_SEARCH_TOOL_ID],
      },
      {
        onDelta: (text) => deltas.push(text),
        onToolActivity: (notes) => activities.push(notes),
      },
    )

    expect(result).toBe('Current finding')
    expect(activities).toEqual([['searching: current outliner apps']])
    expect(deltas).toEqual(['Current finding'])
    const secondContext = mocks.streamSimple.mock.calls[1][1] as Context
    expect(secondContext.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'toolResult',
    ])
    expect(secondContext.messages[2]).toMatchObject({
      role: 'toolResult',
      toolName: WEB_SEARCH_TOOL_ID,
      isError: false,
    })
  })
})
