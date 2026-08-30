import { createCheckpoint, verifyCheckpoint, type OutlineCheckpoint } from './checkpoint'
import { parseEventEnvelope, type EventEnvelope } from './envelope'
import type { OutlineState } from './reducer'

export interface SchemaMigrationContext {
  actorId: string
  deviceId: string
  nextCheckpointId: () => string
  nextEventId: () => string
  now?: () => string
}

export interface SchemaMigrationResult {
  previousCheckpoint: OutlineCheckpoint
  migratedCheckpoint: OutlineCheckpoint
  event: Extract<EventEnvelope, { type: 'document.schema_migrated' }>
}

/** Creates the verified checkpoint boundary required to start a new document epoch. */
export async function createSchemaMigration(
  previousCheckpoint: OutlineCheckpoint,
  toDocumentVersion: number,
  migrate: (state: OutlineState) => OutlineState,
  context: SchemaMigrationContext,
): Promise<SchemaMigrationResult> {
  if (!(await verifyCheckpoint(previousCheckpoint))) throw new Error('Cannot migrate a corrupted checkpoint.')
  if (toDocumentVersion <= previousCheckpoint.documentVersion) throw new Error('A schema migration must advance the document version.')
  const schemaEpoch = previousCheckpoint.schemaEpoch + 1
  const state = structuredClone(migrate(structuredClone(previousCheckpoint.state)))
  state.schemaEpoch = schemaEpoch
  const migratedCheckpoint = await createCheckpoint(state, {
    id: context.nextCheckpointId(), outlineId: previousCheckpoint.outlineId,
    documentVersion: toDocumentVersion, schemaEpoch,
    localSequence: previousCheckpoint.localSequence,
    serverRevision: previousCheckpoint.serverRevision,
  })
  const event = parseEventEnvelope({
    id: context.nextEventId(), outlineId: previousCheckpoint.outlineId,
    actorId: context.actorId, deviceId: context.deviceId,
    type: 'document.schema_migrated', eventVersion: 1,
    documentVersion: toDocumentVersion, schemaEpoch,
    baseRevision: previousCheckpoint.serverRevision,
    origin: 'migration', occurredAt: (context.now ?? (() => new Date().toISOString()))(),
    payload: {
      fromVersion: previousCheckpoint.documentVersion,
      toVersion: toDocumentVersion,
      checkpointHash: migratedCheckpoint.integrityHash,
    },
  }) as Extract<EventEnvelope, { type: 'document.schema_migrated' }>
  return { previousCheckpoint, migratedCheckpoint, event }
}
