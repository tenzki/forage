import { invoke } from '@tauri-apps/api/core'
import {
  canonicalJson,
  parseEventEnvelope,
  sha256Hex,
  replayOutlineEvents,
  reduceOutlineEvent,
  type EventEnvelope,
  type OutlineState,
} from '@forage/domain'
import {
  captureStepBatch,
  createReplayOutlineSchema,
  documentChangeSteps,
  repairSystemNodes,
  rebaseSerializedSteps,
  type SerializedStepBatch,
} from '@forage/document'
import {
  checkpointBootstrapResponseSchema,
  pullEventsResponseSchema,
  pushEventsResponseSchema,
  serverStatusSchema,
  type ServerStatus,
} from '@forage/protocol'
import type {
  RebaseCommit,
  ReplayInput,
  StoredCheckpoint,
  StoredEventRecord,
} from '../persistence/eventStore'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'

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
  eventsAfter(outlineId: string, localSequence: number): Promise<StoredEventRecord[]>
  commitRebase(outlineId: string, commit: RebaseCommit): Promise<void>
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

function outlineStateFromCheckpoint(value: Record<string, unknown>): OutlineState {
  if (!value.doc || typeof value.doc !== 'object' || Array.isArray(value.doc)
    || !Array.isArray(value.trash) || !Array.isArray(value.shortcuts)
    || typeof value.schemaEpoch !== 'number') {
    throw new Error('Server checkpoint contains an invalid outline projection.')
  }
  return {
    doc: value.doc as Record<string, unknown>,
    trash: value.trash as Record<string, unknown>[],
    shortcuts: value.shortcuts as Record<string, unknown>[],
    schemaEpoch: value.schemaEpoch,
  }
}

export class DesktopSyncEngine {
  state: SyncState = { kind: 'offline' }
  historyInvalidated = false

  constructor(
    private readonly repository: SyncRepository,
    private readonly transport: SyncTransport,
    private readonly onState: (state: SyncState) => void = () => undefined,
    private readonly clientVersion = '0.1.0',
  ) {}

  async sync(): Promise<void> {
    this.historyInvalidated = false
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
        const bootstrapState = outlineStateFromCheckpoint(checkpoint.state)
        const actualHash = await sha256Hex(canonicalJson(bootstrapState))
        if (actualHash !== checkpoint.integrityHash) throw new Error('Server checkpoint integrity verification failed.')
        const stateJson = JSON.stringify(checkpoint.state)
        const storedCheckpoint: StoredCheckpoint = {
          id: checkpoint.id, outlineId: checkpoint.outlineId,
          documentVersion: checkpoint.documentVersion, schemaEpoch: checkpoint.schemaEpoch,
          localSequence: 0, serverRevision: checkpoint.revision, stateJson,
          integrityHash: checkpoint.integrityHash, createdAt: new Date().toISOString(),
        }
        await this.repository.saveCheckpoint(storedCheckpoint)
        revision = checkpoint.revision
        replay = await this.repository.loadReplayInput(outlineId) ?? {
          checkpoint: storedCheckpoint,
          state: bootstrapState,
          events: [],
        }
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
        revision = await this.pullAll(outlineId, revision, replay)
      }
      this.transition({ kind: 'up-to-date', revision })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('authentication_required')) this.transition({ kind: 'authentication-required' })
      else if (message.includes('upgrade_required')) this.transition({ kind: 'upgrade-required', message })
      else this.transition({ kind: 'server-unavailable', message })
    }
  }

  private async pullAll(outlineId: string, after: number, replayInput?: ReplayInput): Promise<number> {
    let cursor = after
    const replay = replayInput ?? await this.repository.loadReplayInput(outlineId)
    if (!replay) throw new Error('A local checkpoint is required before pulling events.')
    let projected = replayOutlineEvents(replay.state, replay.events)
    for (;;) {
      const page = await this.transport.pull(cursor, 100)
      for (const event of page.events) {
        const parsed = parseEventEnvelope(event)
        projected = reduceOutlineEvent(projected, parsed)
        await this.repository.append(parsed)
        if (invalidatesDocumentHistory(parsed)) this.historyInvalidated = true
        cursor = Math.max(cursor, parsed.revision ?? cursor)
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
    const recordsAfterCheckpoint = await this.repository.eventsAfter(
      outlineId,
      replayBeforeRemote.checkpoint.localSequence,
    )
    const allPendingIds = new Set(recordsAfterCheckpoint
      .filter((record) => record.status === 'pending' && !record.supersededBy)
      .map((record) => record.id))
    const acceptedBeforeRemote = replayBeforeRemote.events.filter((event) => !allPendingIds.has(event.id))
    const baseState = replayOutlineEvents(replayBeforeRemote.state, acceptedBeforeRemote)
    const missingEvents: EventEnvelope[] = []
    let validatedRemoteState = baseState
    let cursor = response.pullAfterRevision
    let replacementBase = response.currentRevision
    for (;;) {
      const page = await this.transport.pull(cursor, 100)
      for (const event of page.events) {
        const parsed = parseEventEnvelope(event)
        validatedRemoteState = reduceOutlineEvent(validatedRemoteState, parsed)
        missingEvents.push(parsed)
        cursor = Math.max(cursor, parsed.revision ?? cursor)
      }
      replacementBase = page.currentRevision
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
        replacements.push(replacement)
        continue
      }
      const documentPayload = eventDocumentPayload(event)
      if (!documentPayload) {
        this.transition({
          kind: 'conflict',
          message: 'A pending domain change could not be safely transformed automatically.',
          eventIds: pending.map((candidate) => candidate.id),
        })
        return replacementBase
      }
      const schema = createReplayOutlineSchema(originalState.schemaEpoch)
      const originalDocument = schema.nodeFromJSON(originalState.doc)
      const remoteDocument = schema.nodeFromJSON(rebasedState.doc)
      let rebasingEvent: EventEnvelope
      let rebased
      try {
        if (event.type === 'trash.entry_added' && event.payload.document) {
          const refreshed = refreshTrashSnapshot(event, remoteDocument)
          rebasingEvent = refreshed.event
          const resolved = remoteDocument.resolve(refreshed.pos)
          const removesOnlyNestedChild = resolved.parent.type.name === 'bulletList'
            && resolved.parent.childCount === 1
            && resolved.depth > 0
            && resolved.node(resolved.depth - 1).type.name === 'listItem'
          const deleteFrom = removesOnlyNestedChild
            ? resolved.before(resolved.depth)
            : refreshed.pos
          const deleteTo = removesOnlyNestedChild
            ? deleteFrom + resolved.parent.nodeSize
            : refreshed.pos + refreshed.node.nodeSize
          const transaction = EditorState.create({ schema, doc: remoteDocument }).tr
            .delete(deleteFrom, deleteTo)
          rebased = { ...captureStepBatch(remoteDocument, transaction.steps), doc: transaction.doc }
        } else {
          rebasingEvent = event
          const rebasingDocumentPayload = eventDocumentPayload(rebasingEvent)
          if (!rebasingDocumentPayload) throw new Error('The rebased event lost its document payload.')
          rebased = rebaseSerializedSteps(originalDocument, rebasingDocumentPayload, documentChangeSteps(originalDocument, remoteDocument))
        }
      } catch {
        this.transition({ kind: 'conflict', message: 'The local edit overlaps a remote edit and could not be preserved.', eventIds: [event.id] })
        return replacementBase
      }
      if (rebased.steps.length === 0) {
        this.transition({ kind: 'conflict', message: 'The local edit was removed by a conflicting remote edit.', eventIds: [event.id] })
        return replacementBase
      }
      const rebasedProjection = event.origin === 'migration'
        ? repairSystemNodes(rebased.doc.toJSON() as Record<string, unknown>, () => {
          throw new Error('A rebased migration unexpectedly requires a new node id.')
        }).doc
        : rebased.doc.toJSON()
      const provisionalReplacement = parseEventEnvelope({
        ...rebasingEvent,
        id: crypto.randomUUID(),
        baseRevision: replacementBase,
        revision: undefined,
        payload: replaceEventDocumentPayload(rebasingEvent, {
          steps: rebased.steps,
          inverseSteps: rebased.inverseSteps,
          beforeHash: await sha256Hex(canonicalJson(remoteDocument.toJSON())),
          afterHash: await sha256Hex(canonicalJson(rebasedProjection)),
        }),
      })
      const nextOriginalState = reduceOutlineEvent(originalState, event)
      const nextRebasedState = reduceOutlineEvent(rebasedState, provisionalReplacement)
      const projectedAfter = schema.nodeFromJSON(nextRebasedState.doc)
      const replacement = parseEventEnvelope({
        ...provisionalReplacement,
        payload: replaceEventDocumentPayload(provisionalReplacement, {
          afterHash: await sha256Hex(canonicalJson(projectedAfter.toJSON())),
        }),
      })
      originalState = nextOriginalState
      rebasedState = nextRebasedState
      replacements.push(replacement)
    }
    const retry = await this.transport.push(replacementBase, replacements)
    if (retry.status !== 'accepted') {
      this.transition({ kind: 'conflict', message: 'The server changed again during rebase.', eventIds: replacements.map((event) => event.id) })
      return retry.currentRevision
    }
    await this.repository.commitRebase(outlineId, {
      pulledEvents: missingEvents,
      replacements: replacements.map((event, index) => ({ originalId: pending[index].id, event })),
      pulledRevision: cursor,
      acknowledgements: retry.acknowledgements.map((item) => [item.eventId, item.revision]),
    })
    if (missingEvents.some(invalidatesDocumentHistory) || pending.some(invalidatesDocumentHistory)) {
      this.historyInvalidated = true
    }
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

type EventDocumentPayload = SerializedStepBatch & {
  beforeHash: string
  afterHash: string
}

function eventDocumentPayload(event: EventEnvelope): EventDocumentPayload | null {
  if (isDocumentEvent(event)) return event.payload
  if ((event.type === 'trash.entry_added' || event.type === 'trash.entry_restored') && event.payload.document) {
    return event.payload.document
  }
  return null
}

function replaceEventDocumentPayload(
  event: EventEnvelope,
  patch: Partial<EventDocumentPayload>,
): EventEnvelope['payload'] {
  if (event.type === 'trash.entry_added' || event.type === 'trash.entry_restored') {
    if (!event.payload.document) throw new Error('The Trash event does not contain a document change.')
    return {
      ...event.payload,
      document: { ...event.payload.document, ...patch },
    }
  }
  if (!isDocumentEvent(event)) throw new Error('The event does not contain a document change.')
  return { ...event.payload, ...patch }
}

function refreshTrashSnapshot(
  event: Extract<EventEnvelope, { type: 'trash.entry_added' }>,
  remoteDocument: ProseMirrorNode,
): { event: EventEnvelope; node: ProseMirrorNode; pos: number } {
  const storedNode = event.payload.entry.node
  if (!storedNode || typeof storedNode !== 'object' || Array.isArray(storedNode)) {
    throw new Error('The pending Trash entry does not contain a valid branch snapshot.')
  }
  const attrs = (storedNode as Record<string, unknown>).attrs
  const nodeId = attrs && typeof attrs === 'object' && !Array.isArray(attrs)
    ? (attrs as Record<string, unknown>).nodeId
    : null
  if (typeof nodeId !== 'string') throw new Error('The pending Trash branch has no stable identity.')
  const match: { node?: ProseMirrorNode; pos: number } = { pos: -1 }
  remoteDocument.descendants((node, pos) => {
    if (node.type.name === 'listItem' && node.attrs.nodeId === nodeId) {
      match.node = node
      match.pos = pos
      return false
    }
    return undefined
  })
  if (!match.node || match.pos < 0) throw new Error('The branch moved to Trash was removed remotely.')
  const found = match.node
  const foundPos = match.pos
  const resolved = remoteDocument.resolve(foundPos)
  let originalParentId: string | null = null
  for (let depth = resolved.depth; depth >= 0; depth -= 1) {
    const ancestor = resolved.node(depth)
    if (ancestor.type.name === 'listItem') {
      originalParentId = String(ancestor.attrs.nodeId)
      break
    }
  }
  return {
    node: found,
    pos: foundPos,
    event: parseEventEnvelope({
      ...event,
      payload: {
        ...event.payload,
        entry: {
          ...event.payload.entry,
          node: found.toJSON(),
          originalParentId,
          originalIndex: resolved.index(),
        },
      },
    }),
  }
}

function invalidatesDocumentHistory(event: EventEnvelope): boolean {
  return event.type === 'note.created'
    || event.type === 'document.schema_migrated'
    || eventDocumentPayload(event) !== null
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
