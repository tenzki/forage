import {
  captureStepBatch,
  createOutlineSchema,
  deserializeStep,
  documentChangeSteps,
  repairSystemNodes,
} from '../../document/src'
import { canonicalJson, sha256Hex } from './checkpoint'
import { parseEventEnvelope, type EventEnvelope } from './envelope'
import type { OutlineState } from './reducer'

export interface SystemNodeMigrationContext {
  outlineId: string
  actorId: string
  deviceId: string
  baseRevision: number
  nextEventId: () => string
  nextNodeId: () => string
  now?: () => string
}

export type DocumentRepairContext = Omit<SystemNodeMigrationContext, 'nextNodeId'>

export interface SystemNodeMigrationResult {
  event: Extract<EventEnvelope, { type: 'document.steps_applied' }>
  state: OutlineState
}

/** Persist an already-computed compatibility repair as one replayable event. */
export async function buildDocumentRepairEvent(
  state: OutlineState,
  repairedDoc: Record<string, unknown>,
  context: DocumentRepairContext,
): Promise<SystemNodeMigrationResult | null> {
  if (JSON.stringify(state.doc) === JSON.stringify(repairedDoc)) return null
  const schema = createOutlineSchema()
  const before = schema.nodeFromJSON(state.doc)
  const after = schema.nodeFromJSON(repairedDoc)
  const serializedSteps = documentChangeSteps(before, after)
  if (!serializedSteps.length) return null
  const batch = captureStepBatch(
    before,
    serializedSteps.map((step) => deserializeStep(schema, step)),
  )
  const event = parseEventEnvelope({
    id: context.nextEventId(),
    outlineId: context.outlineId,
    actorId: context.actorId,
    deviceId: context.deviceId,
    type: 'document.steps_applied',
    eventVersion: 1,
    documentVersion: 1,
    schemaEpoch: state.schemaEpoch,
    baseRevision: context.baseRevision,
    origin: 'migration',
    occurredAt: (context.now ?? (() => new Date().toISOString()))(),
    payload: {
      ...batch,
      beforeHash: await sha256Hex(canonicalJson(before.toJSON())),
      afterHash: await sha256Hex(canonicalJson(after.toJSON())),
    },
  }) as Extract<EventEnvelope, { type: 'document.steps_applied' }>
  return {
    event,
    state: { ...structuredClone(state), doc: after.toJSON() as Record<string, unknown> },
  }
}

export async function buildSystemNodeRepairEvent(
  state: OutlineState,
  context: SystemNodeMigrationContext,
): Promise<SystemNodeMigrationResult | null> {
  const repaired = repairSystemNodes(state.doc, context.nextNodeId)
  if (!repaired.changed) return null
  return buildDocumentRepairEvent(state, repaired.doc, context)
}
