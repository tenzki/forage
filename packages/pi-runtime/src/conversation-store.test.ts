import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { CONVERSATION_UNAVAILABLE, conversationDirectory, conversationPath, createFileConversationStore, createRehydratedConversation, parseRunThread } from './conversation-store'
import { runPiTurn, type PiTurnRequest } from './run-turn'
import { scriptedModel } from './scripted-model.test-support'

function request(turn = 1, runId = `run-${turn}`): PiTurnRequest {
  return { runId, executionMode: 'local', instructions: [], prompt: turn === 1 ? 'Research tides.' : 'Why?', context: [],
    effectiveToolIds: [], requiredToolIds: [], thread: { callId: 'call-1', turn } }
}
const images = { get: () => undefined }

describe('durable conversation storage', () => {
  let directory: string
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'forage-durable-store-')) })
  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  it('derives paths only from validated call IDs', () => {
    expect(conversationDirectory(directory)).toBe(join(directory, 'agent-sessions'))
    expect(conversationPath(directory, 'call-1')).toBe(join(directory, 'call-1.sqlite'))
    for (const callId of ['../outside', '/tmp/outside', '', 'a.b', 'a'.repeat(129)]) {
      expect(() => conversationPath(directory, callId)).toThrow('invalid conversation')
    }
    expect(parseRunThread(undefined)).toBeUndefined()
    expect(() => parseRunThread({ callId: 'valid', turn: 0 })).toThrow('invalid conversation')
  })

  it('persists a completed call and resumes it after every connection closes', async () => {
    const conversation = createFileConversationStore(directory)
    const first = await scriptedModel([fauxAssistantMessage(fauxToolCall('emit_outline', { nodes: [{ text: 'The moon.' }] }))])
    await runPiTurn(request(), { ...first, conversation, images })
    expect(existsSync(conversationPath(directory, 'call-1'))).toBe(true)
    const second = await scriptedModel([(context) => {
      expect(JSON.stringify(context.messages)).toContain('The moon.')
      return fauxAssistantMessage(fauxText('Gravity.'))
    }])
    await expect(runPiTurn(request(2), { ...second, conversation: createFileConversationStore(directory), images }))
      .resolves.toEqual({ type: 'answer', text: 'Gravity.' })
  })

  it('fails closed when a reply has no readable stored history', async () => {
    const conversation = createFileConversationStore(directory)
    await expect(conversation.openTurn({ callId: 'missing', turn: 2 })).rejects.toThrow(CONVERSATION_UNAVAILABLE)
    writeFileSync(join(directory, 'broken.jsonl'), 'not json')
    await expect(conversation.openTurn({ callId: 'broken', turn: 2 })).rejects.toThrow(CONVERSATION_UNAVAILABLE)
  })

  it('exclusively owns a call until its SQLite connection closes', async () => {
    const store = createFileConversationStore(directory)
    const first = await store.openTurn({ callId: 'call-1', turn: 1 })
    try { await expect(store.openTurn({ callId: 'call-1', turn: 1 })).rejects.toThrow(/locked|busy/i) }
    finally { await first.storage.close(BACKGROUND_CONTEXT) }
    const next = await store.openTurn({ callId: 'call-1', turn: 1 })
    await next.close()
  })

  it('imports a legacy SDK conversation without modifying its source file', async () => {
    const path = join(directory, 'call-1.jsonl')
    const legacy = [
      { type: 'session', version: 3, id: 'old-session' },
      { type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: 'Remember kelp.', timestamp: 1 } },
      { type: 'message', id: 'a1', parentId: 'u1', message: fauxAssistantMessage('Kelp remembered.') },
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n'
    writeFileSync(path, legacy)
    // Opening before the import commits simulates an interrupted first upgrade.
    const interrupted = await createFileConversationStore(directory).openTurn({ callId: 'call-1', turn: 2 })
    await interrupted.close()
    const model = await scriptedModel([(context) => {
      expect(JSON.stringify(context.messages)).toContain('Remember kelp.')
      return fauxAssistantMessage('Kelp.')
    }])
    await expect(runPiTurn(request(2), { ...model, conversation: createFileConversationStore(directory), images }))
      .resolves.toEqual({ type: 'answer', text: 'Kelp.' })
    expect(readFileSync(path, 'utf8')).toBe(legacy)
  })

  it('captures only the new successful turn for the atomic server settlement contract', async () => {
    const first = createRehydratedConversation([])
    await runPiTurn(request(), { ...await scriptedModel([fauxAssistantMessage('The moon.')]), conversation: first.store, images })
    expect(first.appendedEntries().length).toBeGreaterThan(0)
    const second = createRehydratedConversation(first.appendedEntries())
    await runPiTurn(request(2), { ...await scriptedModel([fauxAssistantMessage('Gravity.')]), conversation: second.store, images })
    const entries = JSON.stringify(second.appendedEntries())
    expect(entries).toContain('Gravity.')
    expect(entries).not.toContain('The moon.')
    await first.dispose(); await second.dispose()
  })
})
