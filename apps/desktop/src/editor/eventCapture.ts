import type { Transaction } from '@tiptap/pm/state'
import {
  applySerializedSteps,
  captureStepBatch,
} from '@forage/document'
import {
  canonicalJson,
  parseEventEnvelope,
  sha256Hex,
  type EventEnvelope,
} from '@forage/domain'

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

export async function buildDocumentEvent(
  root: Transaction,
  appendedTransactions: readonly Transaction[],
  context: DocumentEventContext,
): Promise<Extract<EventEnvelope, { type: 'document.steps_applied' | 'document.undo_applied' | 'document.redo_applied' }> | null> {
  const transactions = [root, ...appendedTransactions]
  if (root.getMeta('preventUpdate') === true || root.getMeta('forageRemote') === true) return null
  const steps = transactions.flatMap((transaction) => transaction.steps)
  if (steps.length === 0 || !transactions.some((transaction) => transaction.docChanged)) return null

  const batch = captureStepBatch(root.before, steps)
  const after = applySerializedSteps(root.before, batch.steps)
  const compensation = root.getMeta(COMPENSATION_META) as CompensationMetadata | undefined
  const type = compensation?.type ?? 'document.steps_applied'
  const payload = {
    ...batch,
    beforeHash: await sha256Hex(canonicalJson(root.before.toJSON())),
    afterHash: await sha256Hex(canonicalJson(after.toJSON())),
    ...(compensation ? { targetEventIds: compensation.targetEventIds } : {}),
  }
  return parseEventEnvelope({
    id: context.nextEventId(),
    outlineId: context.outlineId,
    actorId: context.actorId,
    deviceId: context.deviceId,
    type,
    eventVersion: 1,
    documentVersion: 1,
    schemaEpoch: 1,
    baseRevision: context.baseRevision,
    origin: context.origin ?? 'desktop',
    occurredAt: (context.now ?? (() => new Date().toISOString()))(),
    changeGroupId: context.nextChangeGroupId(),
    payload,
  }) as Extract<EventEnvelope, { type: 'document.steps_applied' | 'document.undo_applied' | 'document.redo_applied' }>
}
