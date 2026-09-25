import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionManager } from '@earendil-works/pi-coding-agent'

import {
  CONVERSATION_UNAVAILABLE,
  conversationDirectory,
  conversationPath,
  openConversationTurn,
  parseRunThread,
} from './conversation-store'

function userMessage(text: string) {
  return { role: 'user' as const, content: [{ type: 'text' as const, text }], timestamp: Date.now() }
}

function assistantMessage(text: string) {
  return {
    role: 'assistant' as const,
    content: [{ type: 'text' as const, text }],
    api: 'openai-responses', provider: 'openai', model: 'gpt-5.5',
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop' as const,
    timestamp: Date.now(),
  }
}

function completeTurn(sessionManager: SessionManager, question: string, answer: string): void {
  sessionManager.appendMessage(userMessage(question))
  sessionManager.appendMessage(assistantMessage(answer) as never)
}

function transcript(sessionManager: SessionManager): string[] {
  return sessionManager.buildSessionContext().messages.map((message) => {
    const content = (message as { content: Array<{ type: string; text?: string }> }).content
    return `${message.role}: ${content.map((part) => part.text ?? '').join('')}`
  })
}

describe('call conversation store', () => {
  let agentDir: string
  let directory: string

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), 'forage-conversations-'))
    directory = conversationDirectory(agentDir)
  })

  afterEach(() => rmSync(agentDir, { recursive: true, force: true }))

  it('stores a call under agent-sessions/<callId>.jsonl and resumes it on the next turn', () => {
    const first = openConversationTurn(directory, { callId: 'call-1', turn: 1 })
    completeTurn(first.sessionManager, 'Task: research tides', 'Tides follow the moon.')
    expect(first.sessionManager.getSessionFile()).toBe(join(agentDir, 'agent-sessions', 'call-1.jsonl'))
    expect(existsSync(conversationPath(directory, 'call-1'))).toBe(true)

    const second = openConversationTurn(directory, { callId: 'call-1', turn: 2 })
    expect(transcript(second.sessionManager)).toEqual([
      'user: Task: research tides',
      'assistant: Tides follow the moon.',
    ])
    completeTurn(second.sessionManager, 'User follow-up: why?', 'Gravity.')

    const third = openConversationTurn(directory, { callId: 'call-1', turn: 3 })
    expect(transcript(third.sessionManager)).toHaveLength(4)
  })

  it('fails a reply closed when the conversation is missing or unreadable', () => {
    expect(() => openConversationTurn(directory, { callId: 'missing', turn: 2 })).toThrow(CONVERSATION_UNAVAILABLE)

    openConversationTurn(directory, { callId: 'call-1', turn: 1 })
    writeFileSync(conversationPath(directory, 'corrupt'), 'not a session\n')
    expect(() => openConversationTurn(directory, { callId: 'corrupt', turn: 2 })).toThrow(CONVERSATION_UNAVAILABLE)
    expect(existsSync(conversationPath(directory, 'missing'))).toBe(false)
  })

  it('rolls a failed reply back to the last completed turn', () => {
    const first = openConversationTurn(directory, { callId: 'call-1', turn: 1 })
    completeTurn(first.sessionManager, 'Task: research tides', 'Tides follow the moon.')

    const failed = openConversationTurn(directory, { callId: 'call-1', turn: 2 })
    completeTurn(failed.sessionManager, 'User follow-up: cancelled question', 'Partial answer')
    failed.rollback()
    failed.rollback()

    const resumed = openConversationTurn(directory, { callId: 'call-1', turn: 2 })
    expect(transcript(resumed.sessionManager)).toEqual([
      'user: Task: research tides',
      'assistant: Tides follow the moon.',
    ])
  })

  it('discards a failed first turn and restarts a stale first attempt', () => {
    const failed = openConversationTurn(directory, { callId: 'call-1', turn: 1 })
    completeTurn(failed.sessionManager, 'Task: first attempt', 'Partial')
    failed.rollback()
    expect(existsSync(conversationPath(directory, 'call-1'))).toBe(false)

    const interrupted = openConversationTurn(directory, { callId: 'call-2', turn: 1 })
    completeTurn(interrupted.sessionManager, 'Task: interrupted attempt', 'Partial')
    const retried = openConversationTurn(directory, { callId: 'call-2', turn: 1 })
    expect(transcript(retried.sessionManager)).toEqual([])
  })

  it('derives paths only from validated call identity', () => {
    expect(parseRunThread(undefined)).toBeUndefined()
    expect(parseRunThread({ callId: 'call-1', turn: 2 })).toEqual({ callId: 'call-1', turn: 2 })
    for (const thread of [
      { callId: '../escape', turn: 1 }, { callId: 'a/b', turn: 1 }, { callId: '', turn: 1 },
      { callId: 'call-1', turn: 0 }, { callId: 'call-1', turn: 1.5 }, { callId: 'call-1' }, null, 'call-1',
    ]) {
      expect(() => parseRunThread(thread)).toThrow(/invalid conversation turn/i)
    }
    expect(() => conversationPath(directory, '../escape')).toThrow()
    expect(() => conversationDirectory('')).toThrow(/unavailable/i)
  })
})
