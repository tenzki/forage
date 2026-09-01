import type { Transaction } from '@tiptap/pm/state'
import {
  applySerializedSteps,
  captureStepBatch,
  type SerializedStepBatch,
} from '@forage/document'
import {
  canonicalJson,
  parseEventEnvelope,
  sha256Hex,
  type EventEnvelope,
} from '@forage/domain'
import type { TrashEntry } from '../types/tree'

export interface DocumentEventContext {
  outlineId: string
  actorId: string
  deviceId: string
  baseRevision: number
  nextEventId: () => string
  nextChangeGroupId: () => string
  now?: () => string
  origin?: 'desktop' | 'server' | 'migration'
}

export interface CompensationMetadata {
  type: 'document.undo_applied' | 'document.redo_applied'
  targetEventIds: string[]
}

export const COMPENSATION_META = 'forageCompensation'
export const DOMAIN_MUTATION_META = 'forageDomainMutation'

export type EditorDomainMutation =
  | { type: 'trash.entry_added'; entry: TrashEntry }
  | { type: 'trash.entry_restored'; entryId: string }

export interface CapturedDocumentEvent {
  id: string
  outlineId: string
  actorId: string
  deviceId: string
  type: 'document.steps_applied' | 'document.undo_applied' | 'document.redo_applied'
  eventVersion: 1
  documentVersion: 1
  schemaEpoch: 1
  baseRevision: number
  origin: 'desktop' | 'server' | 'migration'
  occurredAt: string
  changeGroupId: string
  payload: SerializedStepBatch & { targetEventIds?: string[] }
  before: Record<string, unknown>
  after: Record<string, unknown>
}

export type CapturedTrashEvent = Omit<CapturedDocumentEvent, 'type' | 'payload'> & (
  | {
    type: 'trash.entry_added'
    payload: { entry: Record<string, unknown>; document: SerializedStepBatch }
  }
  | {
    type: 'trash.entry_restored'
    payload: { entryId: string; document: SerializedStepBatch }
  }
)

export type CapturedEditorEvent = CapturedDocumentEvent | CapturedTrashEvent

export function captureDocumentEvent(
  root: Transaction,
  appendedTransactions: readonly Transaction[],
  context: DocumentEventContext,
): CapturedEditorEvent | null {
  const transactions = [root, ...appendedTransactions]
  if (root.getMeta('preventUpdate') === true || root.getMeta('forageRemote') === true) return null
  const steps = transactions.flatMap((transaction) => transaction.steps)
  if (steps.length === 0 || !transactions.some((transaction) => transaction.docChanged)) return null

  const batch = captureStepBatch(root.before, steps)
  const after = applySerializedSteps(root.before, batch.steps)
  const compensation = root.getMeta(COMPENSATION_META) as CompensationMetadata | undefined
  const domainMutation = root.getMeta(DOMAIN_MUTATION_META) as EditorDomainMutation | undefined
  const base: Omit<CapturedDocumentEvent, 'type' | 'payload'> = {
    id: context.nextEventId(),
    outlineId: context.outlineId,
    actorId: context.actorId,
    deviceId: context.deviceId,
    eventVersion: 1,
    documentVersion: 1,
    schemaEpoch: 1,
    baseRevision: context.baseRevision,
    origin: context.origin ?? 'desktop',
    occurredAt: (context.now ?? (() => new Date().toISOString()))(),
    changeGroupId: context.nextChangeGroupId(),
    before: root.before.toJSON() as Record<string, unknown>,
    after: after.toJSON() as Record<string, unknown>,
  }
  if (domainMutation?.type === 'trash.entry_added') {
    return {
      ...base,
      type: domainMutation.type,
      payload: {
        entry: domainMutation.entry as unknown as Record<string, unknown>,
        document: batch,
      },
    }
  }
  if (domainMutation?.type === 'trash.entry_restored') {
    return {
      ...base,
      type: domainMutation.type,
      payload: { entryId: domainMutation.entryId, document: batch },
    }
  }
  return {
    ...base,
    type: compensation?.type ?? 'document.steps_applied',
    payload: {
      ...batch,
      ...(compensation ? { targetEventIds: compensation.targetEventIds } : {}),
    },
  }
}

export async function finalizeDocumentEvent(
  captured: CapturedEditorEvent,
): Promise<EventEnvelope> {
  const beforeHash = await sha256Hex(canonicalJson(captured.before))
  const afterHash = await sha256Hex(canonicalJson(captured.after))
  if (captured.type === 'trash.entry_added' || captured.type === 'trash.entry_restored') {
    const { before, after, payload, ...envelope } = captured
    return parseEventEnvelope({
      ...envelope,
      payload: {
        ...payload,
        document: { ...payload.document, beforeHash, afterHash },
      },
    })
  }
  const { before, after, payload, ...envelope } = captured
  return parseEventEnvelope({
    ...envelope,
    payload: {
      ...payload,
      beforeHash,
      afterHash,
    },
  })
}

export async function buildDocumentEvent(
  root: Transaction,
  appendedTransactions: readonly Transaction[],
  context: DocumentEventContext,
): Promise<EventEnvelope | null> {
  const captured = captureDocumentEvent(root, appendedTransactions, context)
  return captured ? finalizeDocumentEvent(captured) : null
}
