import { describe, expect, it } from 'vitest'

import { composeSystemPrompt, composeTaskMessage, UNTRUSTED_MATERIAL_RULE, VERIFIED_CITATION_RULE } from '@forage/pi-runtime'

import { decodePayload, turnRequest, type RunPayload } from './payload'

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function taskMessage(payload: RunPayload): string {
  const request = turnRequest(payload)
  return composeTaskMessage({ ...request, followUp: (request.thread?.turn ?? 1) > 1 })
}

const base = {
  runId: 'run-2', instructions: 'Research the topic.', prompt: 'Which source said that?',
  context: ['- Oceans', '  - Tides'], enabledToolIds: [], requiredToolIds: [], customTools: [],
}

describe('sidecar turn payload', () => {
  it('keeps the first-turn task message unchanged', () => {
    const payload = decodePayload(encode({ ...base, prompt: 'Research tides.' }))

    expect(payload.thread).toBeUndefined()
    expect(taskMessage(payload)).toBe(
      'Selected outline context (hierarchy preserved by indentation):\n- Oceans\n  - Tides\n\nTask: Research tides.',
    )
    expect(taskMessage(decodePayload(encode({ ...base, prompt: 'Research tides.', thread: { callId: 'run-1', turn: 1 } }))))
      .toBe(taskMessage(payload))
  })

  it('builds a follow-up with fresh context, the invocation subtree, and the reply', () => {
    const payload = decodePayload(encode({
      ...base, thread: { callId: 'run-1', turn: 2 },
      invocationOutline: ['- [agent] Tides follow the moon.', '- [user] My own note'],
    }))

    expect(payload.thread).toEqual({ callId: 'run-1', turn: 2 })
    expect(taskMessage(payload)).toBe([
      'Selected outline context (hierarchy preserved by indentation):',
      '- Oceans',
      '  - Tides',
      '',
      'Outline under the invocation bullet:',
      '- [agent] Tides follow the moon.',
      '- [user] My own note',
      '',
      'User follow-up: Which source said that?',
    ].join('\n'))
    expect(taskMessage({ ...payload, context: [], invocationOutline: [] }))
      .toBe('Outline under the invocation bullet:\n(no bullets)\n\nUser follow-up: Which source said that?')
  })

  it('applies the shared untrusted-material and citation rules to local runs', () => {
    const request = turnRequest(decodePayload(encode(base)))
    expect(request).toMatchObject({ executionMode: 'local', instructions: ['Research the topic.'] })

    const firstTurn = composeSystemPrompt({ ...request, followUp: false })
    expect(firstTurn.startsWith('Research the topic.\n\n')).toBe(true)
    expect(firstTurn).toContain(UNTRUSTED_MATERIAL_RULE)
    expect(firstTurn).toContain(VERIFIED_CITATION_RULE)
    expect(firstTurn).toMatch(/calling emit_outline/)
    const followUp = composeSystemPrompt({ ...request, followUp: true })
    expect(followUp).toContain(VERIFIED_CITATION_RULE)
    expect(followUp).toMatch(/answer in plain text and do not call emit_outline/)
  })

  it('bounds the combined context and rejects invalid conversation turns', () => {
    expect(() => decodePayload(encode({
      ...base, context: ['x'.repeat(30_000)], invocationOutline: ['y'.repeat(10_001)],
    }))).toThrow(/safety limit/)
    expect(() => decodePayload(encode({ ...base, invocationOutline: [1] }))).toThrow(/invalid outline context/)
    expect(() => decodePayload(encode({ ...base, thread: { callId: '../x', turn: 2 } }))).toThrow(/conversation turn/)
  })
})
