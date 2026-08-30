import { invoke } from '@tauri-apps/api/core'
import {
  canonicalJson,
  parseEventEnvelope,
  sha256Hex,
  replayOutlineEvents,
  reduceOutlineEvent,
  type EventEnvelope,
} from '@forage/domain'
import {
  applySerializedSteps,
  createOutlineSchema,
  documentChangeSteps,
  rebaseSerializedSteps,
} from '@forage/document'
import {
  checkpointBootstrapResponseSchema,
  pullEventsResponseSchema,
  pushEventsResponseSchema,
  serverStatusSchema,
  type ServerStatus,
} from '@forage/protocol'
import type {
  ReplayInput,
  StoredCheckpoint,
  StoredEventRecord,
} from '../persistence/eventStore'

export type SyncState =
  | { kind: 'local-only' }
  | { kind: 'offline' }
  | { kind: 'connecting' }
  | { kind: 'syncing' }
  | { kind: 'up-to-date'; revision: number }
  | { kind: 'conflict'; message: string; eventIds: string[] }
  | { kind: 'authentication-required' }
  | { kind: 'upgrade-required'; message: string }
  | { kind: 'server-unavailable'; message: string }

export interface SyncRepository {
  storageMode(): Promise<'local' | 'server'>
  loadReplayInput(outlineId: string): Promise<ReplayInput | null>
  saveCheckpoint(checkpoint: StoredCheckpoint): Promise<void>
  append(event: unknown): Promise<number>
  pending(outlineId: string, limit?: number): Promise<StoredEventRecord[]>
  acknowledge(outlineId: string, acknowledgements: Array<[string, number]>): Promise<void>
  supersede(eventId: string, replacementId: string): Promise<void>
  syncState(outlineId: string): Promise<{ lastAckedRevision: number; lastPulledRevision: number }>
  recordPulled(outlineId: string, revision: number): Promise<void>
}

export interface SyncTransport {
  status(): Promise<ServerStatus>
  checkpoint(): Promise<unknown>
  pull(afterRevision: number, limit?: number): Promise<{
    events: EventEnvelope[]; currentRevision: number; nextAfterRevision: number | null
  }>
  push(baseRevision: number, events: EventEnvelope[]): Promise<
    | { status: 'accepted'; acknowledgements: Array<{ eventId: string; revision: number }>; currentRevision: number }
    | { status: 'rebase_required'; currentRevision: number; pullAfterRevision: number }
  >
}

export class NativeSyncTransport implements SyncTransport {
  async status(): Promise<ServerStatus> {
    return serverStatusSchema.parse(await invoke('server_test_connection'))
  }
  async checkpoint(): Promise<unknown> { return invoke('server_checkpoint') }
  async pull(afterRevision: number, limit = 100) {
    return pullEventsResponseSchema.parse(await invoke('server_pull_events', { afterRevision, limit }))
  }
  async push(baseRevision: number, events: EventEnvelope[]) {
    return pushEventsResponseSchema.parse(await invoke('server_push_events', { baseRevision, events }))
  }
}

export class DesktopSyncEngine {
  state: SyncState = { kind: 'offline' }

  constructor(
    private readonly repository: SyncRepository,
    private readonly transport: SyncTransport,
    private readonly onState: (state: SyncState) => void = () => undefined,
    private readonly clientVersion = '0.1.0',
  ) {}

  async sync(): Promise<void> {
    if (await this.repository.storageMode() === 'local') {
      this.transition({ kind: 'local-only' })
      return
    }
    this.transition({ kind: 'connecting' })
    try {
      const status = await this.transport.status()
      if (!status.apiVersions.includes(1) || status.documentSchemaVersion !== 1 || compareVersions(this.clientVersion, status.minimumClientVersion) < 0) {
        this.transition({ kind: 'upgrade-required', message: 'This server requires a newer Forage client.' })
        return
      }
      this.transition({ kind: 'syncing' })
      const bootstrap = checkpointBootstrapResponseSchema.parse(await this.transport.checkpoint()).checkpoint
      const outlineId = bootstrap.outlineId
      let replay = await this.repository.loadReplayInput(outlineId)
      let revision = 0
      if (!replay) {
        const checkpoint = bootstrap
        const actualHash = await sha256Hex(canonicalJson(checkpoint.state))
        if (actualHash !== checkpoint.integrityHash) throw new Error('Server checkpoint integrity verification failed.')
        const stateJson = JSON.stringify(checkpoint.state)
        await this.repository.saveCheckpoint({
          id: checkpoint.id, outlineId: checkpoint.outlineId,
          documentVersion: checkpoint.documentVersion, schemaEpoch: checkpoint.schemaEpoch,
          localSequence: 0, serverRevision: checkpoint.revision, stateJson,
          integrityHash: checkpoint.integrityHash, createdAt: new Date().toISOString(),
        })
        revision = checkpoint.revision
        replay = await this.repository.loadReplayInput(outlineId)
      } else {
        revision = Math.max(replay.checkpoint.serverRevision, ...replay.events.map((event) => event.revision ?? 0))
      }

      let pending = await this.repository.pending(outlineId, 100)
      if (pending.length > 0) {
        while (pending.length > 0) {
          revision = await this.pushPending(outlineId, revision, pending)
          if (this.state.kind === 'conflict') return
          if (pending.length < 100) break
          pending = await this.repository.pending(outlineId, 100)
        }
        if (this.state.kind === 'conflict') return
      } else {
        revision = await this.pullAll(outlineId, revision)
      }
      this.transition({ kind: 'up-to-date', revision })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('authentication_required')) this.transition({ kind: 'authentication-required' })
      else if (message.includes('upgrade_required')) this.transition({ kind: 'upgrade-required', message })
      else this.transition({ kind: 'server-unavailable', message })
    }
  }

  private async pullAll(outlineId: string, after: number): Promise<number> {
    let cursor = after
    for (;;) {
      const page = await this.transport.pull(cursor, 100)
      for (const event of page.events) {
        await this.repository.append(parseEventEnvelope(event))
        cursor = Math.max(cursor, event.revision ?? cursor)
      }
      await this.repository.recordPulled(outlineId, cursor)
      if (page.nextAfterRevision === null) return Math.max(cursor, page.currentRevision)
      cursor = page.nextAfterRevision
    }
  }

  private async pushPending(outlineId: string, baseRevision: number, records: StoredEventRecord[]): Promise<number> {
    const pending = records.map((record) => parseEventEnvelope(record.envelope))
    const response = await this.transport.push(baseRevision, pending)
    if (response.status === 'accepted') {
      await this.repository.acknowledge(
        outlineId,
        response.acknowledgements.map((item) => [item.eventId, item.revision]),
      )
      return response.currentRevision
    }

    const replayBeforeRemote = await this.repository.loadReplayInput(outlineId)
    if (!replayBeforeRemote) throw new Error('A local checkpoint is required before rebase.')
    const pendingIds = new Set(pending.map((event) => event.id))
    const acceptedBeforeRemote = replayBeforeRemote.events.filter((event) => !pendingIds.has(event.id))
    const baseState = replayOutlineEvents(replayBeforeRemote.state, acceptedBeforeRemote)
    const missingEvents: EventEnvelope[] = []
    let cursor = response.pullAfterRevision
    let replacementBase = response.currentRevision
    for (;;) {
      const page = await this.transport.pull(cursor, 100)
      for (const event of page.events) {
        const parsed = parseEventEnvelope(event)
        missingEvents.push(parsed)
        await this.repository.append(parsed)
        cursor = Math.max(cursor, parsed.revision ?? cursor)
      }
      replacementBase = page.currentRevision
      await this.repository.recordPulled(outlineId, cursor)
      if (page.nextAfterRevision === null) break
      cursor = page.nextAfterRevision
    }
    let originalState = baseState
    let rebasedState = replayOutlineEvents(baseState, missingEvents)
    const replacements: EventEnvelope[] = []
    for (const event of pending) {
      if (event.type === 'note.created') {
        const replacement = parseEventEnvelope({
          ...event,
          id: crypto.randomUUID(),
          baseRevision: replacementBase,
          revision: undefined,
        })
        originalState = reduceOutlineEvent(originalState, event)
        rebasedState = reduceOutlineEvent(rebasedState, replacement)
        await this.repository.append(replacement)
        await this.repository.supersede(event.id, replacement.id)
        replacements.push(replacement)
        continue
      }
      if (!isDocumentEvent(event)) {
        this.transition({
          kind: 'conflict',
          message: 'A pending domain change could not be safely transformed automatically.',
          eventIds: pending.map((candidate) => candidate.id),
        })
        return replacementBase
      }
      const schema = createOutlineSchema()
      const originalDocument = schema.nodeFromJSON(originalState.doc)
      const remoteDocument = schema.nodeFromJSON(rebasedState.doc)
      let rebased
      try {
        rebased = rebaseSerializedSteps(originalDocument, event.payload, documentChangeSteps(originalDocument, remoteDocument))
      } catch {
        this.transition({ kind: 'conflict', message: 'The local edit overlaps a remote edit and could not be preserved.', eventIds: [event.id] })
        return replacementBase
      }
      if (rebased.steps.length === 0) {
        this.transition({ kind: 'conflict', message: 'The local edit was removed by a conflicting remote edit.', eventIds: [event.id] })
        return replacementBase
      }
      const replacement = parseEventEnvelope({
        ...event,
        id: crypto.randomUUID(),
        baseRevision: replacementBase,
        revision: undefined,
        payload: {
          ...event.payload,
          steps: rebased.steps,
          inverseSteps: rebased.inverseSteps,
          beforeHash: await sha256Hex(canonicalJson(remoteDocument.toJSON())),
          afterHash: await sha256Hex(canonicalJson(rebased.doc.toJSON())),
        },
      })
      originalState = { ...reduceOutlineEvent(originalState, event), doc: applySerializedSteps(originalDocument, event.payload.steps).toJSON() }
      rebasedState = { ...rebasedState, doc: rebased.doc.toJSON() }
      await this.repository.append(replacement)
      await this.repository.supersede(event.id, replacement.id)
      replacements.push(replacement)
    }
    const retry = await this.transport.push(replacementBase, replacements)
    if (retry.status !== 'accepted') {
      this.transition({ kind: 'conflict', message: 'The server changed again during rebase.', eventIds: replacements.map((event) => event.id) })
      return retry.currentRevision
    }
    await this.repository.acknowledge(
      outlineId,
      retry.acknowledgements.map((item) => [item.eventId, item.revision]),
    )
    return retry.currentRevision
  }

  private transition(state: SyncState): void {
    this.state = state
    this.onState(state)
  }
}

function isDocumentEvent(event: EventEnvelope): event is Extract<EventEnvelope, {
  type: 'document.steps_applied' | 'document.undo_applied' | 'document.redo_applied'
}> {
  return event.type === 'document.steps_applied' || event.type === 'document.undo_applied' || event.type === 'document.redo_applied'
}

function compareVersions(left: string, right: string): number {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return Math.sign(difference)
  }
  return 0
}
