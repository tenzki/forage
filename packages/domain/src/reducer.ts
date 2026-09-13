import {
  applySerializedSteps,
  createReplayOutlineSchema,
  insertPlainTextNote,
  insertAgentResult,
  repairSystemNodes,
  type SerializedStep,
} from '../../document/src'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
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
  return reduceInto(clone(current), event)
}

function reduceInto(state: OutlineState, event: EventEnvelope): OutlineState {
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
      const document = parseDocument(state.doc, state.schemaEpoch)
      const result = applySerializedSteps(document, event.payload.steps as SerializedStep[])
      const projected = result.toJSON() as JsonObject
      // Early system-node migrations were recorded before the editor coalesced
      // legacy root lists. Replaying the same deterministic repair keeps their
      // already-recorded follow-up steps aligned; current migrations are idempotent here.
      const repaired = event.origin === 'migration'
      if (repaired) {
        state.doc = repairSystemNodes(projected, () => {
          throw new Error('A system-node migration replay unexpectedly requires a new node id.')
        }).doc
      } else {
        state.doc = projected
        parsedDocuments.set(projected, result)
      }
      assertDocumentHash(state.doc, event.payload.afterHash, event.id, 'after', state.schemaEpoch, !repaired)
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
        const trashResult = applySerializedSteps(
          parseDocument(state.doc, state.schemaEpoch),
          event.payload.document.steps as SerializedStep[],
        )
        state.doc = trashResult.toJSON() as JsonObject
        parsedDocuments.set(state.doc, trashResult)
        assertDocumentHash(state.doc, event.payload.document.afterHash, event.id, 'after', state.schemaEpoch, true)
      }
      state.trash.push(clone(event.payload.entry))
      return state
    case 'trash.entry_restored':
      if (event.payload.document) {
        assertDocumentHash(state.doc, event.payload.document.beforeHash, event.id, 'before', state.schemaEpoch)
        const trashResult = applySerializedSteps(
          parseDocument(state.doc, state.schemaEpoch),
          event.payload.document.steps as SerializedStep[],
        )
        state.doc = trashResult.toJSON() as JsonObject
        parsedDocuments.set(state.doc, trashResult)
        assertDocumentHash(state.doc, event.payload.document.afterHash, event.id, 'after', state.schemaEpoch, true)
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
      const noted = insertPlainTextNote(parseDocument(state.doc, state.schemaEpoch), event.payload)
      state.doc = noted.toJSON() as JsonObject
      parsedDocuments.set(state.doc, noted)
      return state
    }
    case 'asset.reference_added':
      return state
    case 'agent.result_committed': {
      const projected = insertAgentResult(parseDocument(state.doc, state.schemaEpoch), {
        targetNodeId: event.payload.targetNodeId,
        nodes: event.payload.nodes,
      })
      state.doc = projected.toJSON() as JsonObject
      parsedDocuments.set(state.doc, projected)
      return state
    }
  }
}

const canonicalDocumentHashes = new WeakMap<JsonObject, string>()

const parsedDocuments = new WeakMap<JsonObject, ProseMirrorNode>()

function parseDocument(doc: JsonObject, schemaEpoch: number): ProseMirrorNode {
  const remembered = parsedDocuments.get(doc)
  if (remembered) return remembered
  const parsed = createReplayOutlineSchema(schemaEpoch).nodeFromJSON(doc)
  parsedDocuments.set(doc, parsed)
  return parsed
}

function documentHash(doc: JsonObject, schemaEpoch: number, canonical: boolean): string {
  const remembered = canonicalDocumentHashes.get(doc)
  if (remembered !== undefined) return remembered
  const source = canonical ? doc : parseDocument(doc, schemaEpoch).toJSON() as JsonObject
  const hash = sha256HexSync(canonicalJson(source))
  canonicalDocumentHashes.set(doc, hash)
  return hash
}

function assertDocumentHash(
  doc: JsonObject,
  expected: string,
  eventId: string,
  phase: 'before' | 'after',
  schemaEpoch: number,
  canonical = false,
): void {
  const actual = documentHash(doc, schemaEpoch, canonical)
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
  let state = clone(initial)
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    try {
      state = reduceInto(state, event)
    } catch (error) {
      throw new OutlineReplayError(event, index, state.schemaEpoch, error)
    }
  }
  return state
}
