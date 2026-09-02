import {
  applySerializedSteps,
  createReplayOutlineSchema,
  insertPlainTextNote,
  repairSystemNodes,
  type SerializedStep,
} from '../../document/src'
import type { EventEnvelope } from './envelope'
import { canonicalJson, sha256HexSync } from './checkpoint'

export type JsonObject = Record<string, unknown>

export interface OutlineState {
  doc: JsonObject
  trash: JsonObject[]
  shortcuts: JsonObject[]
  schemaEpoch: number
}

export class OutlineReplayError extends Error {
  readonly eventId: string
  readonly eventIndex: number
  readonly schemaEpoch: number
  readonly cause: unknown

  constructor(event: EventEnvelope, eventIndex: number, schemaEpoch: number, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(`Outline replay stopped at event ${event.id}: ${detail}`)
    this.name = 'OutlineReplayError'
    this.eventId = event.id
    this.eventIndex = eventIndex
    this.schemaEpoch = schemaEpoch
    this.cause = cause
  }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

export function createInitialOutlineState(doc: JsonObject): OutlineState {
  return { doc: clone(doc), trash: [], shortcuts: [], schemaEpoch: 1 }
}

export function reduceOutlineEvent(current: OutlineState, event: EventEnvelope): OutlineState {
  const state = clone(current)
  if (event.type !== 'document.schema_migrated' && event.schemaEpoch !== state.schemaEpoch) {
    throw new Error(
      `Event ${event.id} uses schema epoch ${event.schemaEpoch}, but the outline is at epoch ${state.schemaEpoch}.`,
    )
  }
  switch (event.type) {
    case 'document.steps_applied':
    case 'document.undo_applied':
    case 'document.redo_applied': {
      assertDocumentHash(state.doc, event.payload.beforeHash, event.id, 'before', state.schemaEpoch)
      const document = createReplayOutlineSchema(state.schemaEpoch).nodeFromJSON(state.doc)
      const projected = applySerializedSteps(
        document,
        event.payload.steps as SerializedStep[],
      ).toJSON() as JsonObject
      // Early system-node migrations were recorded before the editor coalesced
      // legacy root lists. Replaying the same deterministic repair keeps their
      // already-recorded follow-up steps aligned; current migrations are idempotent here.
      state.doc = event.origin === 'migration'
        ? repairSystemNodes(projected, () => {
          throw new Error('A system-node migration replay unexpectedly requires a new node id.')
        }).doc
        : projected
      assertDocumentHash(state.doc, event.payload.afterHash, event.id, 'after', state.schemaEpoch)
      return state
    }
    case 'shortcut.created':
      state.shortcuts.push(shortcutProjection(event.payload.shortcut))
      return state
    case 'shortcut.updated':
      state.shortcuts = state.shortcuts.map((shortcut) => (
        shortcut.id === event.payload.shortcut.id ? shortcutProjection(event.payload.shortcut) : shortcut
      ))
      return state
    case 'shortcut.deleted':
      state.shortcuts = state.shortcuts.filter((shortcut) => shortcut.id !== event.payload.shortcutId)
      return state
    case 'shortcuts.reordered': {
      const positions = new Map(event.payload.shortcutIds.map((id, index) => [id, index]))
      state.shortcuts.sort((left, right) => (
        (positions.get(String(left.id)) ?? Number.MAX_SAFE_INTEGER)
        - (positions.get(String(right.id)) ?? Number.MAX_SAFE_INTEGER)
      ))
      return state
    }
    case 'trash.entry_added':
      if (event.payload.document) {
        assertDocumentHash(state.doc, event.payload.document.beforeHash, event.id, 'before', state.schemaEpoch)
        const document = createReplayOutlineSchema(state.schemaEpoch).nodeFromJSON(state.doc)
        state.doc = applySerializedSteps(
          document,
          event.payload.document.steps as SerializedStep[],
        ).toJSON() as JsonObject
        assertDocumentHash(state.doc, event.payload.document.afterHash, event.id, 'after', state.schemaEpoch)
      }
      state.trash.push(clone(event.payload.entry))
      return state
    case 'trash.entry_restored':
      if (event.payload.document) {
        assertDocumentHash(state.doc, event.payload.document.beforeHash, event.id, 'before', state.schemaEpoch)
        const document = createReplayOutlineSchema(state.schemaEpoch).nodeFromJSON(state.doc)
        state.doc = applySerializedSteps(
          document,
          event.payload.document.steps as SerializedStep[],
        ).toJSON() as JsonObject
        assertDocumentHash(state.doc, event.payload.document.afterHash, event.id, 'after', state.schemaEpoch)
      }
      state.trash = state.trash.filter((entry) => entry.id !== event.payload.entryId)
      return state
    case 'trash.entry_purged':
      state.trash = state.trash.filter((entry) => entry.id !== event.payload.entryId)
      return state
    case 'document.schema_migrated':
      state.schemaEpoch = event.schemaEpoch
      return state
    case 'note.created': {
      const document = createReplayOutlineSchema(state.schemaEpoch).nodeFromJSON(state.doc)
      state.doc = insertPlainTextNote(document, event.payload).toJSON() as JsonObject
      return state
    }
    case 'asset.reference_added':
      return state
  }
}

function assertDocumentHash(
  doc: JsonObject,
  expected: string,
  eventId: string,
  phase: 'before' | 'after',
  schemaEpoch: number,
): void {
  // ProseMirror supplies default attributes while parsing. Events are captured
  // from that canonical form, so replay must compare the same representation
  // even when an older checkpoint omitted default-valued attributes.
  const canonicalDocument = createReplayOutlineSchema(schemaEpoch).nodeFromJSON(doc).toJSON()
  const actual = sha256HexSync(canonicalJson(canonicalDocument))
  if (actual !== expected) {
    throw new Error(`Document integrity mismatch ${phase} event ${eventId}: expected ${expected}, got ${actual}.`)
  }
}

function shortcutProjection(shortcut: EventPayloadShortcut): JsonObject {
  if (shortcut.kind === 'node') {
    return { id: shortcut.id, type: 'node', target: shortcut.nodeId }
  }
  if (shortcut.kind === 'tag') {
    return { id: shortcut.id, type: 'tag', target: shortcut.tag }
  }
  return {
    id: shortcut.id,
    type: 'search',
    target: shortcut.query,
    label: shortcut.label,
    scopeId: shortcut.scopeId ?? null,
  }
}

type EventPayloadShortcut = Extract<EventEnvelope, { type: 'shortcut.created' }>['payload']['shortcut']

export function replayOutlineEvents(
  initial: OutlineState,
  events: readonly EventEnvelope[],
): OutlineState {
  let state = initial
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    try {
      state = reduceOutlineEvent(state, event)
    } catch (error) {
      throw new OutlineReplayError(event, index, state.schemaEpoch, error)
    }
  }
  return state
}
