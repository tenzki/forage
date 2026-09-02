import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { NativeEventRepository } from './eventStore'

describe('native event repository', () => {
  beforeEach(() => invoke.mockReset())

  it('appends validated envelopes immediately through the narrow native command', async () => {
    invoke.mockResolvedValueOnce(4)
    const repository = new NativeEventRepository()
    const sequence = await repository.append({
      id: 'event-1', outlineId: 'outline-1', actorId: 'owner-1', deviceId: 'device-1',
      type: 'shortcut.created', eventVersion: 1, documentVersion: 1, schemaEpoch: 1,
      baseRevision: 0, origin: 'desktop', occurredAt: '2026-08-30T12:00:00.000Z',
      payload: { shortcut: { id: 'shortcut-1', kind: 'node', nodeId: 'root' } },
    })

    expect(sequence).toBe(4)
    expect(invoke).toHaveBeenCalledWith('event_store_append', {
      event: expect.objectContaining({ id: 'event-1', status: 'pending' }),
    })
  })

  it('loads a verified checkpoint and ordered later events for replay', async () => {
    invoke
      .mockResolvedValueOnce({
        id: 'checkpoint-1', outlineId: 'outline-1', documentVersion: 1, schemaEpoch: 1,
        localSequence: 3, serverRevision: 2, stateJson: '{"doc":{"type":"doc"},"trash":[],"shortcuts":[],"schemaEpoch":1}',
        integrityHash: 'a'.repeat(64), createdAt: '2026-08-30T12:00:00.000Z',
      })
      .mockResolvedValueOnce([{ localSequence: 4, serverRevision: 3, status: 'accepted', envelope: {
        id: 'event-4', outlineId: 'outline-1', actorId: 'owner-1', deviceId: 'device-1',
        type: 'shortcut.deleted', eventVersion: 1, documentVersion: 1, schemaEpoch: 1,
        baseRevision: 2, origin: 'desktop', occurredAt: '2026-08-30T12:00:00.000Z',
        payload: { shortcutId: 'shortcut-1' },
      } }])

    const loaded = await new NativeEventRepository().loadReplayInput('outline-1')

    expect(loaded?.checkpoint.localSequence).toBe(3)
    expect(loaded?.latestLocalSequence).toBe(4)
    expect(loaded?.events[0].type).toBe('shortcut.deleted')
    expect(loaded?.events[0].revision).toBe(3)
  })
})
