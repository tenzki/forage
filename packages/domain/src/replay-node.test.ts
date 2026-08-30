// @vitest-environment node
import { describe, expect, it } from 'vitest'
import fixture from '../fixtures/replay-v1.json'
import { createOutlineSchema } from '../../document/src'
import { parseEventEnvelope, replayOutlineEvents, type OutlineState } from './index'

describe('Node.js shared replay fixture', () => {
  it('replays the same fixture used by desktop-compatible shared code', () => {
    const events = fixture.events.map(parseEventEnvelope)
    const result = replayOutlineEvents(fixture.initial as OutlineState, events)
    expect(createOutlineSchema().nodeFromJSON(result.doc).textContent).toBe(fixture.expectedText)
  })
})
