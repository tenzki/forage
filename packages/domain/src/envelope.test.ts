import { describe, expect, it } from 'vitest'
import { parseCommandEnvelope, parseEventEnvelope } from './envelope'

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

  it('requires bounded provenance for agent-origin output events', () => {
    const event = parseEventEnvelope({
      id: 'event-agent-1',
      outlineId: 'outline-1',
      actorId: 'owner-1',
      deviceId: 'server-worker-1',
      type: 'note.created',
      eventVersion: 1,
      documentVersion: 1,
      schemaEpoch: 1,
      baseRevision: 9,
      revision: 10,
      origin: 'agent',
      occurredAt: '2026-08-31T10:00:00.000Z',
      changeGroupId: 'run-1',
      agentProvenance: {
        runId: 'run-1',
        skillId: 'research',
        sourceNodeId: 'capture-1',
        sourceUrls: ['https://example.com/article'],
      },
      payload: { noteId: 'result-1', parentId: 'capture-1', text: 'Summary' },
    })

    expect(event.origin).toBe('agent')
    expect(event.agentProvenance?.runId).toBe('run-1')
    expect(() => parseEventEnvelope({ ...event, agentProvenance: undefined })).toThrow(/provenance/i)
    expect(() => parseEventEnvelope({
      ...event,
      agentProvenance: { ...event.agentProvenance, sourceUrls: Array.from({ length: 21 }, () => 'https://example.com') },
    })).toThrow()
  })

  it('accepts agent-origin command envelopes only with agent provenance', () => {
    const command = {
      id: 'command-agent-1',
      outlineId: 'outline-1',
      actorId: 'owner-1',
      deviceId: 'server-worker-1',
      type: 'agent.result_commit',
      commandVersion: 1,
      documentVersion: 1,
      schemaEpoch: 1,
      baseRevision: 9,
      origin: 'agent',
      issuedAt: '2026-08-31T10:00:00.000Z',
      payload: {},
      agentProvenance: { runId: 'run-1', skillId: 'research', sourceUrls: [] },
    }
    expect(parseCommandEnvelope(command).origin).toBe('agent')
    expect(() => parseCommandEnvelope({ ...command, agentProvenance: undefined })).toThrow(/provenance/i)
  })
})
