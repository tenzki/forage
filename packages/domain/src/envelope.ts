import { z } from 'zod'

const boundedId = z.string().trim().min(1).max(128)
const revision = z.number().int().nonnegative()
const positiveVersion = z.number().int().positive()

export interface AgentEventProvenance {
  runId: string
  skillId: string
  sourceNodeId?: string
  sourceUrls: string[]
}

const agentEventProvenanceSchema = z.object({
  runId: boundedId,
  skillId: boundedId,
  sourceNodeId: boundedId.optional(),
  sourceUrls: z.array(z.url().max(2_000)).max(20),
}).strict()

const shortcutSchema = z.object({
  id: boundedId,
  kind: z.enum(['node', 'tag', 'search']),
  nodeId: boundedId.optional(),
  tag: z.string().trim().min(1).max(128).optional(),
  query: z.string().trim().min(1).max(500).optional(),
  label: z.string().trim().min(1).max(200).optional(),
  scopeId: boundedId.nullable().optional(),
}).strict()

const stepBatchSchema = z.object({
  steps: z.array(z.record(z.string(), z.unknown())).min(1).max(1_000),
  inverseSteps: z.array(z.record(z.string(), z.unknown())).min(1).max(1_000),
  beforeHash: z.string().regex(/^[a-f0-9]{64}$/),
  afterHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().refine(
  ({ steps, inverseSteps }) => steps.length === inverseSteps.length,
  { message: 'steps and inverseSteps must have equal length' },
)

const eventPayloadSchemas = {
  'document.steps_applied': stepBatchSchema,
  'document.undo_applied': stepBatchSchema.extend({
    targetEventIds: z.array(boundedId).min(1).max(1_000),
  }),
  'document.redo_applied': stepBatchSchema.extend({
    targetEventIds: z.array(boundedId).min(1).max(1_000),
  }),
  'document.schema_migrated': z.object({
    fromVersion: positiveVersion,
    toVersion: positiveVersion,
    checkpointHash: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  'trash.entry_added': z.object({
    entry: z.record(z.string(), z.unknown()),
    document: stepBatchSchema.optional(),
  }).strict(),
  'trash.entry_restored': z.object({
    entryId: boundedId,
    document: stepBatchSchema.optional(),
  }).strict(),
  'trash.entry_purged': z.object({ entryId: boundedId }).strict(),
  'shortcut.created': z.object({ shortcut: shortcutSchema }).strict(),
  'shortcut.updated': z.object({ shortcut: shortcutSchema }).strict(),
  'shortcut.deleted': z.object({ shortcutId: boundedId }).strict(),
  'shortcuts.reordered': z.object({ shortcutIds: z.array(boundedId).max(1_000) }).strict(),
  'note.created': z.object({
    noteId: boundedId,
    parentId: boundedId,
    text: z.string().min(1).max(100_000),
    source: z.record(z.string(), z.string().max(2_000)).optional(),
    clientCreatedAt: z.iso.datetime().optional(),
  }).strict(),
  'asset.reference_added': z.object({
    assetId: z.string().regex(/^[a-f0-9]{64}$/),
    alt: z.string().trim().min(1).max(500),
  }).strict(),
} as const

export type OutlineEventType = keyof typeof eventPayloadSchemas

type JsonRecord = Record<string, unknown>

export interface StepBatchPayload {
  steps: JsonRecord[]
  inverseSteps: JsonRecord[]
  beforeHash: string
  afterHash: string
}

export interface EventPayloadByType {
  'document.steps_applied': StepBatchPayload
  'document.undo_applied': StepBatchPayload & { targetEventIds: string[] }
  'document.redo_applied': StepBatchPayload & { targetEventIds: string[] }
  'document.schema_migrated': { fromVersion: number; toVersion: number; checkpointHash: string }
  'trash.entry_added': { entry: JsonRecord; document?: StepBatchPayload }
  'trash.entry_restored': { entryId: string; document?: StepBatchPayload }
  'trash.entry_purged': { entryId: string }
  'shortcut.created': { shortcut: JsonRecord & { id: string; kind: 'node' | 'tag' | 'search' } }
  'shortcut.updated': { shortcut: JsonRecord & { id: string; kind: 'node' | 'tag' | 'search' } }
  'shortcut.deleted': { shortcutId: string }
  'shortcuts.reordered': { shortcutIds: string[] }
  'note.created': {
    noteId: string
    parentId: string
    text: string
    source?: Record<string, string>
    clientCreatedAt?: string
  }
  'asset.reference_added': { assetId: string; alt: string }
}

interface EventEnvelopeBase {
  id: string
  outlineId: string
  actorId: string
  deviceId: string
  eventVersion: number
  documentVersion: number
  schemaEpoch: number
  baseRevision: number
  revision?: number
  origin: 'desktop' | 'notes_api' | 'server' | 'migration' | 'agent'
  agentProvenance?: AgentEventProvenance
  occurredAt: string
  changeGroupId?: string
}

export type EventEnvelope = {
  [Type in OutlineEventType]: EventEnvelopeBase & {
    type: Type
    payload: EventPayloadByType[Type]
  }
}[OutlineEventType]

const eventBaseSchema = z.object({
  id: boundedId,
  outlineId: boundedId,
  actorId: boundedId,
  deviceId: boundedId,
  eventVersion: positiveVersion,
  documentVersion: positiveVersion,
  schemaEpoch: positiveVersion,
  baseRevision: revision,
  revision: revision.optional(),
  origin: z.enum(['desktop', 'notes_api', 'server', 'migration', 'agent']),
  agentProvenance: agentEventProvenanceSchema.optional(),
  occurredAt: z.iso.datetime({ offset: true }),
  changeGroupId: boundedId.optional(),
}).strict()

const eventVariants = Object.entries(eventPayloadSchemas).map(([type, payload]) =>
  eventBaseSchema.extend({ type: z.literal(type), payload }),
) as unknown as [z.ZodType, ...z.ZodType[]]

const eventUnionSchema = z.union(eventVariants) as z.ZodType<EventEnvelope>

export const eventEnvelopeSchema = eventUnionSchema.superRefine((event, context) => {
  if (event.origin === 'agent' && !event.agentProvenance) {
    context.addIssue({ code: 'custom', path: ['agentProvenance'], message: 'Agent provenance is required for agent-origin events' })
  }
  if (event.origin !== 'agent' && event.agentProvenance) {
    context.addIssue({ code: 'custom', path: ['agentProvenance'], message: 'Agent provenance is only valid for agent-origin events' })
  }
})

export function parseEventEnvelope(value: unknown): EventEnvelope {
  return eventEnvelopeSchema.parse(value)
}

export const commandEnvelopeSchema = z.object({
  id: boundedId,
  outlineId: boundedId,
  actorId: boundedId,
  deviceId: boundedId,
  type: z.string().trim().min(1).max(128),
  commandVersion: positiveVersion,
  documentVersion: positiveVersion,
  schemaEpoch: positiveVersion,
  baseRevision: revision,
  origin: z.enum(['desktop', 'notes_api', 'server', 'migration', 'agent']),
  agentProvenance: agentEventProvenanceSchema.optional(),
  issuedAt: z.iso.datetime({ offset: true }),
  idempotencyKey: z.string().trim().min(1).max(255).optional(),
  payload: z.record(z.string(), z.unknown()),
}).strict().superRefine((command, context) => {
  if (command.origin === 'agent' && !command.agentProvenance) {
    context.addIssue({ code: 'custom', path: ['agentProvenance'], message: 'Agent provenance is required for agent-origin commands' })
  }
  if (command.origin !== 'agent' && command.agentProvenance) {
    context.addIssue({ code: 'custom', path: ['agentProvenance'], message: 'Agent provenance is only valid for agent-origin commands' })
  }
})

export type CommandEnvelope = z.infer<typeof commandEnvelopeSchema>

export function parseCommandEnvelope(value: unknown): CommandEnvelope {
  return commandEnvelopeSchema.parse(value)
}
