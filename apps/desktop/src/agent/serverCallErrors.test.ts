import { describe, expect, it } from 'vitest'
import { SERVER_CALL_MESSAGES, serverCallErrorMessage, serverRunFailureMessage } from './serverCallErrors'

describe('server call errors', () => {
  it('maps refused replies to messages that say what to do next', () => {
    expect(serverCallErrorMessage('call_busy: This call is still working on a reply.', true)).toBe(SERVER_CALL_MESSAGES.call_busy)
    expect(serverCallErrorMessage(new Error('conflict: This call already has a newer reply.'), true)).toBe(SERVER_CALL_MESSAGES.conflict)
    expect(serverCallErrorMessage(new Error('conversation_too_large: too long'), true)).toMatch(/Run the skill again to start a new call/)
    expect(serverCallErrorMessage(new Error('conversation_unavailable: gone'), true)).toMatch(/Run the skill again/)
  })

  it('treats a conflict as a stale turn only for replies and keeps other errors', () => {
    expect(serverCallErrorMessage(new Error('conflict: This outline has not been seeded yet.'), false))
      .toBe('conflict: This outline has not been seeded yet.')
    expect(serverCallErrorMessage(new Error('server unavailable: offline'), true)).toBe('server unavailable: offline')
  })

  it('explains a reply that failed because its transcript is unavailable', () => {
    expect(serverRunFailureMessage({ error: { code: 'conversation_unavailable', message: 'conversation unavailable' } }))
      .toBe(SERVER_CALL_MESSAGES.conversation_unavailable)
    expect(serverRunFailureMessage({ error: { code: 'timeout', message: 'timeout' } })).toBe('timeout')
    expect(serverRunFailureMessage({ error: null })).toBe('The server run failed.')
  })
})
