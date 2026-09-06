import {
  buildDocumentRepairEvent,
  createInitialOutlineState,
  replayOutlineEvents,
  sha256Hex,
  type OutlineState,
} from '@forage/domain'
import type { EventEnvelope } from '@forage/domain'
import { EMPTY_DOC, normalizeOutlinerDoc } from '../editor/emptyDoc'
import { finalizeDocumentEvent, type CapturedEditorEvent } from '../editor/eventCapture'
import {
  rebuildPersistentHistory,
  type PersistentHistoryState,
} from '../editor/persistentHistory'
import type {
  LocalAgentRunHistory,
  LocalIdentity,
  ServerConnectionInfo,
} from '../persistence/eventStore'
import { NativeEventRepository } from '../persistence/eventStore'
import { createAssetReferenceEvents } from '../persistence/domainEvents'
import {
  NativeSyncTransport,
  DesktopSyncEngine,
  type SyncRepository,
  type SyncState,
  type SyncTransport,
} from '../sync/syncEngine'
import type { JsonValue } from '../types/tree'

export type StorageBackend = { kind: 'local' } | { kind: 'server'; origin: string }

export interface OutlineSessionRepository extends SyncRepository {
  identity(): Promise<LocalIdentity>
  serverConnection(): Promise<ServerConnectionInfo | null>
  interruptUnfinishedAgentRuns(interruptedAt: string): Promise<number>
  recentAgentRuns(outlineId: string, limit?: number): Promise<LocalAgentRunHistory[]>
  clearAgentRuns(outlineId: string): Promise<number>
}

export interface OutlineSessionStatus {
  syncState: SyncState
  storageBackend: StorageBackend
  saveError: string | null
  maintenanceError: string | null
}

export interface OutlineEventContext extends LocalIdentity {
  baseRevision: number
  nextEventId: () => string
  now: () => string
}

export interface OpenedOutline {
  state: OutlineState
  storageBackend: StorageBackend
  history: PersistentHistoryState
}

export interface SynchronizedOutline {
  state: OutlineState
  historyInvalidated: boolean
}

export interface SessionSyncEngine {
  state: SyncState
  historyInvalidated: boolean
  sync(): Promise<void>
}

interface OutlineSessionOptions {
  nextId?: () => string
  now?: () => string
  createSyncEngine?: (onState: (state: SyncState) => void) => SessionSyncEngine
}

export class OutlineSession {
  private readonly nextId: () => string
  private readonly now: () => string
  private identityValue: LocalIdentity | null = null
  private localSequence = 0
  private serverRevision = 0
  private appendQueue: Promise<void> = Promise.resolve()
  private failedOperations: Array<() => Promise<void>> = []
  private persistenceBlocked = false
  private checkpointInProgress = false
  private syncInProgress = false
  private readonly listeners = new Set<() => void>()
  private readonly syncEngineFactory: (onState: (state: SyncState) => void) => SessionSyncEngine
  private status: OutlineSessionStatus = {
    syncState: { kind: 'offline' },
    storageBackend: { kind: 'local' },
    saveError: null,
    maintenanceError: null,
  }

  constructor(
    private readonly repository: OutlineSessionRepository = new NativeEventRepository(),
    private readonly transport: SyncTransport = new NativeSyncTransport(),
    options: OutlineSessionOptions = {},
  ) {
    this.nextId = options.nextId ?? (() => crypto.randomUUID())
    this.now = options.now ?? (() => new Date().toISOString())
    this.syncEngineFactory = options.createSyncEngine
      ?? ((onState) => new DesktopSyncEngine(this.repository, this.transport, onState))
  }

  getSnapshot = (): OutlineSessionStatus => this.status

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  context(): OutlineEventContext | null {
    if (!this.identityValue) return null
    return {
      ...this.identityValue,
      baseRevision: this.serverRevision,
      nextEventId: this.nextId,
      now: this.now,
    }
  }

  /** Persisted agent runs for the open outline, newest first. */
  async agentRunHistory(limit = 25): Promise<LocalAgentRunHistory[]> {
    const outlineId = this.identityValue?.outlineId
    if (!outlineId) return []
    return this.repository.recentAgentRuns(outlineId, limit)
  }

  /** Forget persisted agent runs for the open outline. */
  async clearAgentRunHistory(): Promise<void> {
    const outlineId = this.identityValue?.outlineId
    if (!outlineId) return
    await this.repository.clearAgentRuns(outlineId)
  }

  async open(): Promise<OpenedOutline> {
    await this.repository.interruptUnfinishedAgentRuns(this.now())
    const mode = await this.repository.storageMode()
    if (mode === 'server') {
      await this.createSyncEngine().sync()
    } else {
      this.updateStatus({ syncState: { kind: 'local-only' } })
    }

    const localIdentity = await this.repository.identity()
    const connection = mode === 'server' ? await this.repository.serverConnection() : null
    const storageBackend: StorageBackend = connection
      ? { kind: 'server', origin: connection.origin }
      : { kind: 'local' }
    this.updateStatus({ storageBackend })
    const activeIdentity = connection
      ? { ...localIdentity, outlineId: connection.outlineId }
      : localIdentity
    this.identityValue = activeIdentity

    const replay = await this.repository.loadReplayInput(activeIdentity.outlineId)
    const allRecords = await this.repository.eventsAfter(activeIdentity.outlineId, 0) ?? []
    let history = rebuildPersistentHistory(
      allRecords
        .filter((record) => !record.supersededBy)
        .map((record) => record.envelope as EventEnvelope),
      activeIdentity.deviceId,
    )
    let state: OutlineState
    let sealRecoveredCheckpoint = false
    if (replay) {
      state = replayOutlineEvents(replay.state, replay.events)
      this.localSequence = Math.max(
        replay.checkpoint.localSequence,
        ...allRecords.map((record) => record.localSequence),
      )
      sealRecoveredCheckpoint = mode === 'local'
        && this.localSequence > replay.checkpoint.localSequence
      this.serverRevision = replay.checkpoint.serverRevision
    } else {
      state = createInitialOutlineState(
        normalizeOutlinerDoc(EMPTY_DOC, this.nextId) as Record<string, unknown>,
      )
      await this.saveCheckpoint(state, 0, 0)
    }

    const normalizedDoc = normalizeOutlinerDoc(
      state.doc as JsonValue,
      this.nextId,
    ) as Record<string, unknown>
    const repair = await buildDocumentRepairEvent(state, normalizedDoc, {
      ...activeIdentity,
      baseRevision: this.serverRevision,
      nextEventId: this.nextId,
      now: this.now,
    })
    if (repair) {
      this.localSequence = await this.repository.append(repair.event)
      state = repair.state
      history = { undo: [], redo: [] }
      sealRecoveredCheckpoint = mode === 'local'
    }
    if (sealRecoveredCheckpoint) {
      await this.saveCheckpoint(state, this.localSequence, this.serverRevision)
    }

    return { state, storageBackend, history }
  }

  async startEmpty(): Promise<OpenedOutline> {
    const activeIdentity = this.identityValue ?? await this.repository.identity()
    this.identityValue = activeIdentity
    const existingRecords = await this.repository.eventsAfter(activeIdentity.outlineId, 0) ?? []
    this.localSequence = Math.max(0, ...existingRecords.map((record) => record.localSequence))
    this.serverRevision = 0
    const state = createInitialOutlineState(
      normalizeOutlinerDoc(EMPTY_DOC, this.nextId) as Record<string, unknown>,
    )
    await this.saveCheckpoint(state, this.localSequence, 0)
    return {
      state,
      storageBackend: this.status.storageBackend,
      history: { undo: [], redo: [] },
    }
  }

  append(event: EventEnvelope): Promise<void> {
    return this.enqueueOperation(() => this.persistEventNow(event))
  }

  persistCaptured(captured: CapturedEditorEvent): Promise<void> {
    return this.enqueueOperation(async () => {
      const event = await finalizeDocumentEvent(captured)
      await this.persistEventNow(event)
      if (event.type === 'document.steps_applied') {
        for (const reference of createAssetReferenceEvents(event, this.nextId)) {
          await this.persistEventNow(reference)
        }
      }
    })
  }

  dismissSaveError(): void {
    this.updateStatus({ saveError: null })
  }

  dismissMaintenanceError(): void {
    this.updateStatus({ maintenanceError: null })
  }

  retrySave(): Promise<void> {
    const retryOperation = this.appendQueue.then(async () => {
      const retry = this.failedOperations.splice(0)
      this.persistenceBlocked = false
      for (let index = 0; index < retry.length; index += 1) {
        try {
          await retry[index]()
        } catch (error) {
          this.persistenceBlocked = true
          this.failedOperations.push(...retry.slice(index))
          this.updateStatus({ saveError: errorMessage(error) })
          return
        }
      }
      this.updateStatus({ saveError: null })
    })
    this.appendQueue = retryOperation
    return retryOperation
  }

  async retryCheckpoint(): Promise<void> {
    if (!this.identityValue) return
    const outlineId = this.identityValue.outlineId
    const retry = this.appendQueue.then(() => this.refreshRecoveryCheckpoint(outlineId))
    this.appendQueue = retry.catch(() => undefined)
    try {
      await retry
      this.updateStatus({ maintenanceError: null })
    } catch (error) {
      this.updateStatus({ maintenanceError: errorMessage(error) })
    }
  }

  async synchronize(
    applyProjection?: (projection: SynchronizedOutline) => void | Promise<void>,
  ): Promise<SynchronizedOutline | null> {
    if (this.syncInProgress) return null
    this.syncInProgress = true
    const synchronization = this.appendQueue.then(async () => {
      if (this.persistenceBlocked || !this.identityValue) return null
      try {
        const engine = this.createSyncEngine()
        await engine.sync()
        if (engine.state.kind !== 'up-to-date') return null
        this.serverRevision = engine.state.revision
        const replay = await this.repository.loadReplayInput(this.identityValue.outlineId)
        if (!replay) return null
        let state = replayOutlineEvents(replay.state, replay.events)
        const normalizedDoc = normalizeOutlinerDoc(
          state.doc as JsonValue,
          this.nextId,
        ) as Record<string, unknown>
        const repair = await buildDocumentRepairEvent(state, normalizedDoc, {
          ...this.identityValue,
          baseRevision: engine.state.revision,
          nextEventId: this.nextId,
          now: this.now,
        })
        let historyInvalidated = engine.historyInvalidated
        if (repair) {
          this.localSequence = await this.repository.append(repair.event)
          state = repair.state
          historyInvalidated = true
        }
        const result = { state, historyInvalidated }
        await applyProjection?.(result)
        return result
      } catch (error) {
        this.updateStatus({
          syncState: { kind: 'server-unavailable', message: errorMessage(error) },
        })
        return null
      }
    })
    this.appendQueue = synchronization.then(() => undefined)
    try {
      return await synchronization
    } finally {
      this.syncInProgress = false
    }
  }

  private createSyncEngine(): SessionSyncEngine {
    return this.syncEngineFactory((syncState) => {
      if (syncState.kind === 'up-to-date') this.serverRevision = syncState.revision
      this.updateStatus({ syncState })
    })
  }

  private enqueueOperation(operation: () => Promise<void>): Promise<void> {
    const queued = this.appendQueue.then(async () => {
      if (this.persistenceBlocked) {
        this.failedOperations.push(operation)
        return
      }
      try {
        await operation()
        this.updateStatus({ saveError: null })
      } catch (error) {
        this.persistenceBlocked = true
        this.failedOperations.push(operation)
        this.updateStatus({ saveError: errorMessage(error) })
      }
    })
    this.appendQueue = queued
    return queued
  }

  private async persistEventNow(event: EventEnvelope): Promise<void> {
    this.localSequence = await this.repository.append(event)
    if (this.localSequence > 0 && this.localSequence % 100 === 0) {
      try {
        await this.refreshRecoveryCheckpoint(event.outlineId)
        this.updateStatus({ maintenanceError: null })
      } catch (error) {
        this.updateStatus({ maintenanceError: errorMessage(error) })
      }
    }
  }

  private async refreshRecoveryCheckpoint(outlineId: string): Promise<void> {
    // A server-mode checkpoint may only contain acknowledged events. Including
    // pending edits would make the pre-rebase document impossible to recover.
    if (await this.repository.storageMode() === 'server' || this.checkpointInProgress) return
    this.checkpointInProgress = true
    try {
      const replay = await this.repository.loadReplayInput(outlineId)
      if (!replay) return
      const state = replayOutlineEvents(replay.state, replay.events)
      const sequence = replay.latestLocalSequence ?? replay.checkpoint.localSequence
      const revision = Math.max(
        replay.checkpoint.serverRevision,
        ...replay.events.map((candidate) => candidate.revision ?? 0),
      )
      await this.saveCheckpoint(state, sequence, revision)
    } finally {
      this.checkpointInProgress = false
    }
  }

  private async saveCheckpoint(
    state: OutlineState,
    localSequence: number,
    serverRevision: number,
  ): Promise<void> {
    if (!this.identityValue) throw new Error('The outline session has no active identity.')
    const stateJson = JSON.stringify(state)
    await this.repository.saveCheckpoint({
      id: this.nextId(),
      outlineId: this.identityValue.outlineId,
      documentVersion: 1,
      schemaEpoch: state.schemaEpoch,
      localSequence,
      serverRevision,
      stateJson,
      integrityHash: await sha256Hex(stateJson),
      createdAt: this.now(),
    })
  }

  private updateStatus(change: Partial<OutlineSessionStatus>): void {
    const keys = Object.keys(change) as Array<keyof OutlineSessionStatus>
    if (keys.every((key) => Object.is(this.status[key], change[key]))) return
    this.status = { ...this.status, ...change }
    for (const listener of this.listeners) listener()
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
