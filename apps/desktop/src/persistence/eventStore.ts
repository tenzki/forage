import { invoke } from '@tauri-apps/api/core'
import {
  parseEventEnvelope,
  type EventEnvelope,
  type OutlineState,
} from '@forage/domain'
import {
  activityEventSchema,
  runStatusSchema,
  type ActivityEvent,
  type RunInput,
  type RunStatus,
  type StructuredResult,
} from '@forage/agent-runtime'

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

export interface LocalAgentRun {
  id: string
  outlineId: string
  snapshot: RunInput
  status: RunStatus
  attemptCount: number
  resultIdentity: string | null
  result: StructuredResult | null
  retryOfRunId: string | null
  cancelRequestedAt: string | null
  errorCode: string | null
  createdAt: string
  updatedAt: string
}

export interface LocalAgentActivity {
  runId: string
  sequence: number
  event: ActivityEvent
  createdAt: string
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

  async admitAgentRun(run: LocalAgentRun): Promise<void> {
    await invoke('agent_run_admit', { run })
  }

  async agentRun(runId: string): Promise<LocalAgentRun | null> {
    const run = await invoke<LocalAgentRun | null>('agent_run_get', { runId })
    if (!run) return null
    return { ...run, status: runStatusSchema.parse(run.status) }
  }

  async beginAgentAttempt(runId: string, startedAt: string): Promise<number> {
    return invoke('agent_run_begin_attempt', { runId, startedAt })
  }

  async appendAgentActivity(runId: string, event: ActivityEvent, createdAt: string): Promise<number> {
    return invoke('agent_run_append_activity', { runId, event: activityEventSchema.parse(event), createdAt })
  }

  async agentActivityAfter(runId: string, afterSequence: number, limit = 100): Promise<LocalAgentActivity[]> {
    const records = await invoke<LocalAgentActivity[]>('agent_run_activity_after', { runId, afterSequence, limit })
    return records.map((record) => ({ ...record, event: activityEventSchema.parse(record.event) }))
  }

  async cancelAgentRun(runId: string, cancelledAt: string): Promise<void> {
    await invoke('agent_run_cancel', { runId, cancelledAt })
  }

  async settleAgentRun(
    runId: string,
    status: Extract<RunStatus, 'completed' | 'failed' | 'cancelled' | 'interrupted'>,
    resultIdentity: string | null,
    result: StructuredResult | null,
    errorCode: string | null,
    settledAt: string,
  ): Promise<void> {
    await invoke('agent_run_settle', { runId, status, resultIdentity, result, errorCode, settledAt })
  }

  async retryAgentRun(originalRunId: string, run: LocalAgentRun): Promise<void> {
    await invoke('agent_run_retry', { originalRunId, run })
  }

  async interruptUnfinishedAgentRuns(interruptedAt: string): Promise<number> {
    return invoke('agent_run_interrupt_unfinished', { interruptedAt })
  }
}
