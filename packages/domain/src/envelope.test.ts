import { describe, expect, it } from 'vitest'
import { parseEventEnvelope } from './envelope'

describe('event envelope', () => {
  it('validates the complete causal and versioned identity of a persisted event', () => {
    const event = parseEventEnvelope({
      id: 'evt_01J00000000000000000000000',
      outlineId: 'out_01J00000000000000000000000',
      actorId: 'own_01J00000000000000000000000',
      deviceId: 'dev_01J00000000000000000000000',
      type: 'shortcut.created',
      eventVersion: 1,
      documentVersion: 1,
      schemaEpoch: 1,
      baseRevision: 7,
      origin: 'desktop',
      occurredAt: '2026-08-30T12:00:00.000Z',
      changeGroupId: 'chg_01J00000000000000000000000',
      payload: {
        shortcut: { id: 'shortcut-1', kind: 'node', nodeId: 'note-1' },
      },
    })

    expect(event.baseRevision).toBe(7)
    expect(event.payload).toEqual({
      shortcut: { id: 'shortcut-1', kind: 'node', nodeId: 'note-1' },
    })
  })

  it('rejects an event missing causal identity instead of accepting partial history', () => {
    expect(() => parseEventEnvelope({
      id: 'evt_01J00000000000000000000000',
      type: 'shortcut.created',
      eventVersion: 1,
      payload: {},
    })).toThrow(/outlineId/i)
  })
})
