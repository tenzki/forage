import { describe, expect, it } from 'vitest'
import { parseEventEnvelope, type EventEnvelope } from '@forage/domain'
import { rebuildPersistentHistory } from './persistentHistory'

function event(
  type: 'document.steps_applied' | 'document.undo_applied' | 'document.redo_applied',
  id: string,
  targets?: string[],
  changeGroupId = 'group',
): EventEnvelope {
  return parseEventEnvelope({
    id, outlineId: 'outline', actorId: 'owner', deviceId: 'device', type,
    eventVersion: 1, documentVersion: 1, schemaEpoch: 1, baseRevision: 0,
    origin: 'desktop', occurredAt: '2026-08-30T00:00:00.000Z', changeGroupId,
    payload: {
      steps: [{ stepType: 'replace', from: 1, to: 1 }],
      inverseSteps: [{ stepType: 'replace', from: 1, to: 1 }],
      beforeHash: 'a'.repeat(64), afterHash: 'b'.repeat(64),
      ...(targets ? { targetEventIds: targets } : {}),
    },
  })
}

describe('persistent compensating history', () => {
  it('reconstructs grouped undo and redo state after restart', () => {
    const first = event('document.steps_applied', 'first')
    const second = event('document.steps_applied', 'second')
    const undone = event('document.undo_applied', 'undo', ['first', 'second'])
    expect(rebuildPersistentHistory([first, second, undone])).toMatchObject({ undo: [], redo: [{ id: 'group' }] })
    expect(rebuildPersistentHistory([first, second, undone, event('document.redo_applied', 'redo', ['first', 'second'])]))
      .toMatchObject({ undo: [{ id: 'group' }], redo: [] })
  })

  it('treats application-managed document rewrites as a history boundary', () => {
    const userEdit = event('document.steps_applied', 'user-edit')
    const managedEdit = event('document.steps_applied', 'managed-edit', undefined, 'system:daily-note')

    expect(rebuildPersistentHistory([userEdit, managedEdit])).toMatchObject({
      undo: [],
      redo: [],
    })
  })

  it('never exposes compatibility migrations as user undo', () => {
    const userEdit = event('document.steps_applied', 'user-edit')
    const migration = {
      ...event('document.steps_applied', 'migration'),
      origin: 'migration' as const,
    }

    expect(rebuildPersistentHistory([userEdit, migration])).toEqual({ undo: [], redo: [] })
  })

  it('clears local inverses across remote and externally captured document changes', () => {
    const userEdit = event('document.steps_applied', 'user-edit')
    const remoteEdit = { ...event('document.steps_applied', 'remote-edit'), deviceId: 'other-device' }
    const capturedNote = parseEventEnvelope({
      id: 'capture', outlineId: 'outline', actorId: 'owner', deviceId: 'device',
      type: 'note.created', eventVersion: 1, documentVersion: 1, schemaEpoch: 1,
      baseRevision: 0, origin: 'server', occurredAt: '2026-08-30T00:00:00.000Z',
      payload: { noteId: 'note', parentId: 'inbox', text: 'Captured' },
    })

    expect(rebuildPersistentHistory([userEdit, remoteEdit], 'device')).toEqual({ undo: [], redo: [] })
    expect(rebuildPersistentHistory([userEdit, capturedNote], 'device')).toEqual({ undo: [], redo: [] })
  })

  it('treats an atomic trash document mutation as a history boundary', () => {
    const userEdit = event('document.steps_applied', 'user-edit')
    const trashed = parseEventEnvelope({
      id: 'trash', outlineId: 'outline', actorId: 'owner', deviceId: 'device',
      type: 'trash.entry_added', eventVersion: 1, documentVersion: 1, schemaEpoch: 1,
      baseRevision: 0, origin: 'desktop', occurredAt: '2026-08-30T00:00:00.000Z',
      payload: {
        entry: { id: 'trash', deletedAt: '2026-08-30T00:00:00.000Z', originalParentId: null, originalIndex: 0, node: {} },
        document: {
          steps: [{ stepType: 'replace', from: 1, to: 1 }],
          inverseSteps: [{ stepType: 'replace', from: 1, to: 1 }],
          beforeHash: 'a'.repeat(64), afterHash: 'b'.repeat(64),
        },
      },
    })

    expect(rebuildPersistentHistory([userEdit, trashed])).toEqual({ undo: [], redo: [] })
  })
})
