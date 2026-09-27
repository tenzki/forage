import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fauxAssistantMessage, fauxText, fauxToolCall, type Context } from '@earendil-works/pi-ai'
import type { ActivityEvent, RuntimeTool, UntrustedSourceMaterial } from '@forage/agent-runtime'

import { createFileConversationStore } from './conversation-store'
import { CALL_LIMIT_MESSAGE } from './limits'
import { EMIT_OUTLINE_RULE, UNTRUSTED_MATERIAL_RULE, VERIFIED_CITATION_RULE } from './prompt'
import { runPiTurn, type PiTurnAdapters, type PiTurnRequest } from './run-turn'
import { scriptedModel } from './scripted-model.test-support'
import { UNAUTHORIZED_TOOL_MESSAGE } from './tool-policy'

const images = { get: () => undefined }

function request(overrides: Partial<PiTurnRequest> = {}): PiTurnRequest {
  return {
    runId: 'run-1',
    executionMode: 'server',
    instructions: ['You are a researcher.', 'Summarize the topic.'],
    prompt: 'tides',
    context: ['- Oceans', '  - Tides'],
    effectiveToolIds: ['web_read'],
    requiredToolIds: [],
    ...overrides,
  }
}

function webRead(executed: string[] = []): RuntimeTool {
  return {
    id: 'web_read',
    name: 'Web read',
    description: 'Reads a public page.',
    execute: async (arguments_) => {
      const url = String(arguments_.url)
      executed.push(url)
      return {
        trust: 'untrusted', sourceType: 'webpage', canonicalUrl: url, content: `Content of ${url}`,
      } satisfies UntrustedSourceMaterial
    },
  }
}

function emitOutline(text: string, sources: Array<{ url: string; label: string }> = []) {
  return fauxAssistantMessage(fauxToolCall('emit_outline', { nodes: [{ text }], sources }))
}

function lastToolResultText(context: Context): string {
  const result = [...context.messages].reverse().find((message) => message.role === 'toolResult')
  return result?.role === 'toolResult'
    ? result.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
    : ''
}

function userTexts(context: Context): string[] {
  return context.messages.filter((message) => message.role === 'user').map((message) => (
    typeof message.content === 'string'
      ? message.content
      : message.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
  ))
}

async function adapters(steps: Parameters<typeof scriptedModel>[0], extra: Partial<PiTurnAdapters> = {}) {
  const scripted = await scriptedModel(steps)
  return { scripted, adapters: { modelRuntime: scripted.modelRuntime, model: scripted.model, images, ...extra } }
}

describe('runPiTurn', () => {
  it('composes the shared prompt, runs tools and keeps only sources the run read', async () => {
    let seen: Context | undefined
    const read: string[] = []
    const activity: ActivityEvent[] = []
    const { adapters: turnAdapters } = await adapters([
      (context) => {
        seen = context
        return fauxAssistantMessage(fauxToolCall('web_read', { url: 'https://example.com/tides' }))
      },
      emitOutline('Tides follow the moon.', [
        { url: 'https://example.com/tides#moon', label: 'Read page' },
        { url: 'https://example.com/search-result', label: 'Unread lead' },
      ]),
    ], { runtimeTools: [webRead(read)], onActivity: (event) => activity.push(event) })

    const outcome = await runPiTurn(request(), turnAdapters)

    expect(seen?.systemPrompt).toContain('You are a researcher.\n\nSummarize the topic.')
    for (const rule of [UNTRUSTED_MATERIAL_RULE, VERIFIED_CITATION_RULE, EMIT_OUTLINE_RULE]) {
      expect(seen?.systemPrompt).toContain(rule)
    }
    expect(seen?.tools?.map((tool) => tool.name)).toEqual(['web_read', 'emit_outline'])
    expect(userTexts(seen!)).toEqual([
      'Selected outline context (hierarchy preserved by indentation):\n- Oceans\n  - Tides\n\nTask: tides',
    ])
    expect(read).toEqual(['https://example.com/tides'])
    expect(outcome).toEqual({
      type: 'outline',
      outline: {
        action: 'emit_outline',
        nodes: [{ text: 'Tides follow the moon.' }],
        sources: [{ url: 'https://example.com/tides#moon', label: 'Read page' }],
      },
    })
    expect(activity.map(({ kind, phase, label }) => `${kind}:${phase}:${label}`)).toEqual([
      'thinking:start:Thinking',
      'thinking:complete:Thinking',
      'tool:start:web_read',
      'tool:complete:web_read',
      'output:complete:Response ready',
    ])
    expect(activity.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5])
    expect(activity[2].detail).toBe('url: https://example.com/tides')
  })

  it('rejects a run whose required tool is unavailable before any model call', async () => {
    const { scripted, adapters: turnAdapters } = await adapters([emitOutline('never')])

    await expect(runPiTurn(request({ requiredToolIds: ['web_read'] }), turnAdapters))
      .rejects.toMatchObject({ code: 'required_tool_unavailable' })
    expect(scripted.faux.state.callCount).toBe(0)
  })

  it('answers calls to tools outside the effective set as not authorized', async () => {
    let unauthorizedResult = ''
    const { adapters: turnAdapters } = await adapters([
      fauxAssistantMessage(fauxToolCall('shell', { command: 'ls' })),
      (context) => {
        unauthorizedResult = lastToolResultText(context)
        return emitOutline('Done.')
      },
    ], { runtimeTools: [webRead()] })

    await runPiTurn(request(), turnAdapters)
    expect(unauthorizedResult).toBe(UNAUTHORIZED_TOOL_MESSAGE)
  })

  it('runs at most 16 tool calls from one response', async () => {
    const read: string[] = []
    let overflowResult = ''
    const { adapters: turnAdapters } = await adapters([
      fauxAssistantMessage(Array.from({ length: 17 }, (_, index) => (
        fauxToolCall('web_read', { url: `https://example.com/${index}` }, { id: `call-${index}` })
      ))),
      (context) => {
        overflowResult = lastToolResultText(context)
        return emitOutline('Done.')
      },
    ], { runtimeTools: [webRead(read)] })

    await runPiTurn(request(), turnAdapters)
    expect(read).toHaveLength(16)
    expect(read).not.toContain('https://example.com/16')
    expect(overflowResult).toBe(CALL_LIMIT_MESSAGE)
  })

  it('fails with the tool round limit when the model keeps calling tools', async () => {
    const read: string[] = []
    const keepReading = () => fauxAssistantMessage(fauxToolCall('web_read', { url: `https://example.com/${read.length}` }))
    const { scripted, adapters: turnAdapters } = await adapters(
      Array.from({ length: 10 }, () => keepReading),
      { runtimeTools: [webRead(read)] },
    )

    await expect(runPiTurn(request(), turnAdapters, { maxToolRounds: 2 }))
      .rejects.toMatchObject({ code: 'tool_round_limit' })
    expect(read).toHaveLength(2)
    expect(scripted.faux.state.callCount).toBeLessThanOrEqual(3)
  })

  it('allows 20 tool rounds by default and blocks the next round', async () => {
    const read: string[] = []
    const keepReading = () => fauxAssistantMessage(fauxToolCall('web_read', { url: 'https://example.com/tides' }))
    const { adapters: turnAdapters } = await adapters(
      Array.from({ length: 21 }, () => keepReading),
      { runtimeTools: [webRead(read)] },
    )
    await expect(runPiTurn(request(), turnAdapters)).rejects.toMatchObject({ code: 'tool_round_limit' })
    expect(read).toHaveLength(20)
  })

  it('requires an outline from a first server turn but lets a local first turn fall back to text', async () => {
    const server = await adapters([fauxAssistantMessage(fauxText('Plain prose.'))])
    await expect(runPiTurn(request(), server.adapters)).rejects.toMatchObject({ code: 'structured_result_required' })

    const local = await adapters([fauxAssistantMessage(fauxText('Plain prose.'))])
    await expect(runPiTurn(request({ executionMode: 'local' }), local.adapters))
      .resolves.toEqual({ type: 'answer', text: 'Plain prose.' })
  })

  it('reports the provider error when the model fails', async () => {
    const { adapters: turnAdapters } = await adapters([
      fauxAssistantMessage([], { stopReason: 'error', errorMessage: 'Your ChatGPT session has expired.' }),
    ])
    await expect(runPiTurn(request(), turnAdapters)).rejects.toThrow('Your ChatGPT session has expired.')
  })

  describe('with a conversation', () => {
    let directory: string

    beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'forage-pi-turn-')) })
    afterEach(() => rmSync(directory, { recursive: true, force: true }))

    it('resumes the call transcript and answers a follow-up inline', async () => {
      const conversation = createFileConversationStore(directory, directory)
      const thread = { callId: 'call-1', turn: 1 }
      const first = await adapters([emitOutline('Tides follow the moon.')], { conversation })
      await runPiTurn(request({ thread }), first.adapters, { cwd: directory })

      let resumed: Context | undefined
      const second = await adapters([(context) => {
        resumed = context
        return fauxAssistantMessage(fauxText('Because of gravity.'))
      }], { conversation })
      const outcome = await runPiTurn(request({
        thread: { callId: 'call-1', turn: 2 },
        prompt: 'why?',
        invocationOutline: ['- Tides follow the moon.'],
      }), second.adapters, { cwd: directory })

      expect(outcome).toEqual({ type: 'answer', text: 'Because of gravity.' })
      expect(resumed?.systemPrompt).toContain('This is a follow-up turn')
      expect(resumed?.systemPrompt).not.toContain(EMIT_OUTLINE_RULE)
      expect(userTexts(resumed!)).toEqual([
        expect.stringContaining('Task: tides'),
        expect.stringContaining('Outline under the invocation bullet:\n- Tides follow the moon.\n\nUser follow-up: why?'),
      ])
    })

    it('rolls a failed follow-up back so the next reply resumes from the last completed turn', async () => {
      const conversation = createFileConversationStore(directory, directory)
      const first = await adapters([emitOutline('Tides follow the moon.')], { conversation })
      await runPiTurn(request({ thread: { callId: 'call-1', turn: 1 } }), first.adapters, { cwd: directory })

      const failed = await adapters([
        fauxAssistantMessage([], { stopReason: 'error', errorMessage: 'Provider unavailable.' }),
      ], { conversation })
      await expect(runPiTurn(request({ thread: { callId: 'call-1', turn: 2 }, prompt: 'first try' }), failed.adapters, { cwd: directory }))
        .rejects.toThrow('Provider unavailable.')

      let resumed: Context | undefined
      const retried = await adapters([(context) => {
        resumed = context
        return fauxAssistantMessage(fauxText('Answer.'))
      }], { conversation })
      await runPiTurn(request({ thread: { callId: 'call-1', turn: 2 }, prompt: 'second try' }), retried.adapters, { cwd: directory })
      expect(userTexts(resumed!).join('\n')).not.toContain('first try')
    })

    it('fails a follow-up closed without a conversation store', async () => {
      const { scripted, adapters: turnAdapters } = await adapters([fauxAssistantMessage(fauxText('never'))])
      await expect(runPiTurn(request({ thread: { callId: 'call-1', turn: 2 } }), turnAdapters))
        .rejects.toMatchObject({ code: 'conversation_unavailable' })
      expect(scripted.faux.state.callCount).toBe(0)
    })
  })

  it('cancels a running turn and reports it as cancelled', async () => {
    const controller = new AbortController()
    const activity: ActivityEvent[] = []
    const { adapters: turnAdapters } = await adapters([
      fauxAssistantMessage(fauxToolCall('web_read', { url: 'https://example.com/slow' })),
      emitOutline('never'),
    ], {
      onActivity: (event) => activity.push(event),
      runtimeTools: [{
        ...webRead(),
        execute: async () => {
          controller.abort()
          throw new DOMException('Aborted', 'AbortError')
        },
      }],
    })

    await expect(runPiTurn(request(), turnAdapters, { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(activity[activity.length - 1]).toMatchObject({ kind: 'status', phase: 'cancelled' })
  })
})
