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

  it('keeps application-managed document events out of user undo history', () => {
    const userEdit = event('document.steps_applied', 'user-edit')
    const managedEdit = event('document.steps_applied', 'managed-edit', undefined, 'system:daily-note')

    expect(rebuildPersistentHistory([userEdit, managedEdit])).toMatchObject({
      undo: [{ id: 'group', events: [{ id: 'user-edit' }] }],
      redo: [],
    })
  })
})
