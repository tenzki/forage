import { invoke } from '@tauri-apps/api/core'
import {
  parseEventEnvelope,
  type EventEnvelope,
  type OutlineState,
} from '@forage/domain'

export interface StoredEventRecord {
  localSequence: number
  id: string
  outlineId: string
  baseRevision: number
  serverRevision: number | null
  envelope: unknown
  status: 'pending' | 'accepted'
  supersededBy: string | null
  createdAt: string
}

export interface StoredCheckpoint {
  id: string
  outlineId: string
  documentVersion: number
  schemaEpoch: number
  localSequence: number
  serverRevision: number
  stateJson: string
  integrityHash: string
  createdAt: string
}

export interface ReplayInput {
  checkpoint: StoredCheckpoint
  state: OutlineState
  events: EventEnvelope[]
  latestLocalSequence?: number
}

export interface LocalIdentity {
  outlineId: string
  actorId: string
  deviceId: string
}

export interface ServerConnectionInfo {
  origin: string
  instanceId: string
  outlineId: string
}

export interface RebaseCommit {
  pulledEvents: EventEnvelope[]
  replacements: Array<{ originalId: string; event: EventEnvelope }>
  pulledRevision: number
  acknowledgements: Array<[string, number]>
}

function eventRecord(event: EventEnvelope) {
  return {
    id: event.id,
    outlineId: event.outlineId,
    baseRevision: event.baseRevision,
    serverRevision: event.revision ?? null,
    envelope: event,
    status: event.revision === undefined ? 'pending' : 'accepted',
    supersededBy: null,
    createdAt: event.occurredAt,
  }
}

export class NativeEventRepository {
  async identity(): Promise<LocalIdentity> {
    return invoke('event_store_identity')
  }

  async serverConnection(): Promise<ServerConnectionInfo | null> {
    return invoke('server_connection_info')
  }

  async append(eventValue: unknown): Promise<number> {
    const event = parseEventEnvelope(eventValue)
    return invoke<number>('event_store_append', {
      event: eventRecord(event),
    })
  }

  async commitRebase(outlineId: string, commit: RebaseCommit): Promise<void> {
    await invoke('event_store_commit_rebase', {
      outlineId,
      pulledEvents: commit.pulledEvents.map(eventRecord),
      replacements: commit.replacements.map(({ originalId, event }) => [originalId, eventRecord(event)]),
      pulledRevision: commit.pulledRevision,
      acknowledgements: commit.acknowledgements,
    })
  }

  async eventsAfter(outlineId: string, localSequence: number): Promise<StoredEventRecord[]> {
    return invoke('event_store_events_after', { outlineId, localSequence })
  }

  async loadReplayInput(outlineId: string): Promise<ReplayInput | null> {
    const checkpoint = await invoke<StoredCheckpoint | null>('event_store_latest_checkpoint', {
      outlineId,
      documentVersion: 1,
      schemaEpoch: 1,
    })
    if (!checkpoint) return null
    const records = await this.eventsAfter(outlineId, checkpoint.localSequence)
    let state: OutlineState
    try {
      state = JSON.parse(checkpoint.stateJson) as OutlineState
    } catch {
      throw new Error('The local outline checkpoint contains invalid JSON.')
    }
    return {
      checkpoint,
      state,
      latestLocalSequence: Math.max(
        checkpoint.localSequence,
        ...records.map((record) => record.localSequence),
      ),
      events: records
        .filter((record) => !record.supersededBy)
        .map((record) => {
          const event = parseEventEnvelope(record.envelope)
          return typeof record.serverRevision === 'number' && event.revision === undefined
            ? parseEventEnvelope({ ...event, revision: record.serverRevision })
            : event
        }),
    }
  }

  async saveCheckpoint(checkpoint: StoredCheckpoint): Promise<void> {
    await invoke('event_store_save_checkpoint', { checkpoint })
  }

  async pending(outlineId: string, limit = 100): Promise<StoredEventRecord[]> {
    return invoke('event_store_pending', { outlineId, limit })
  }

  async acknowledge(outlineId: string, acknowledgements: Array<[string, number]>): Promise<void> {
    await invoke('event_store_acknowledge', { outlineId, acknowledgements })
  }

  async supersede(eventId: string, replacementId: string): Promise<void> {
    await invoke('event_store_supersede', { eventId, replacementId })
  }

  async storageMode(): Promise<'local' | 'server'> {
    return invoke('event_store_storage_mode')
  }

  async syncState(outlineId: string): Promise<{
    outlineId: string
    lastAckedRevision: number
    lastPulledRevision: number
    serverInstanceId: string | null
  }> {
    return invoke('event_store_sync_state', { outlineId })
  }

  async recordPulled(outlineId: string, revision: number): Promise<void> {
    await invoke('event_store_record_pulled', { outlineId, revision })
  }

  async setStorageMode(mode: 'local' | 'server'): Promise<void> {
    await invoke('event_store_set_storage_mode', { mode })
  }
}
