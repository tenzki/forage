import { describe, expect, it } from 'vitest'
import { encodePayload } from './piGeneration'

function decodePayload(encoded: string): unknown {
  const padded = encoded.replace(/-/g, '+').replace(/_/g, '/')
    .padEnd(Math.ceil(encoded.length / 4) * 4, '=')
  const binary = atob(padded)
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  return JSON.parse(new TextDecoder().decode(bytes))
}

describe('Pi generation bridge', () => {
  it('encodes unicode invocation payloads as base64url', () => {
    const payload = {
      instructions: 'Research carefully — without guessing.',
      prompt: 'Compare café culture ☕',
      context: ['Travel', 'Beograd → Paris'],
      enabledToolIds: [],
      customTools: [],
    }

    const encoded = encodePayload(payload)

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decodePayload(encoded)).toEqual(payload)
  })
})
