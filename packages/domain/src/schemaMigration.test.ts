import { describe, expect, it } from 'vitest'
import { createCheckpoint, createInitialOutlineState, createSchemaMigration, replayOutlineEvents } from './index'

describe('document schema epochs', () => {
  it('starts a new epoch from verified old and migrated checkpoints plus a migration event', async () => {
    const old = await createCheckpoint(createInitialOutlineState({ type: 'doc' }), {
      id: 'old', outlineId: 'outline', documentVersion: 1, schemaEpoch: 1,
      localSequence: 4, serverRevision: 4,
    })
    const migration = await createSchemaMigration(old, 2, (state) => state, {
      actorId: 'owner', deviceId: 'migration-device', nextCheckpointId: () => 'new',
      nextEventId: () => 'migration-event', now: () => '2026-08-30T12:00:00.000Z',
    })
    expect(migration.migratedCheckpoint).toMatchObject({ documentVersion: 2, schemaEpoch: 2 })
    expect(migration.event.payload.checkpointHash).toBe(migration.migratedCheckpoint.integrityHash)
    expect(replayOutlineEvents(migration.migratedCheckpoint.state, [migration.event]).schemaEpoch).toBe(2)
  })

  it('refuses to migrate a checkpoint whose integrity hash is invalid', async () => {
    const old = await createCheckpoint(createInitialOutlineState({ type: 'doc' }), {
      id: 'old', outlineId: 'outline', documentVersion: 1, schemaEpoch: 1,
      localSequence: 0, serverRevision: 0,
    })
    await expect(createSchemaMigration({ ...old, integrityHash: '0'.repeat(64) }, 2, (state) => state, {
      actorId: 'owner', deviceId: 'device', nextCheckpointId: () => 'new', nextEventId: () => 'event',
    })).rejects.toThrow(/corrupted/i)
  })
})
