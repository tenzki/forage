import { z } from 'zod'
import { eventEnvelopeSchema } from '../../domain/src'

export * from './agent'
export * from './siteDomain'

const boundedId = z.string().trim().min(1).max(128)
const revision = z.number().int().nonnegative()

export const notesCreateRequestSchema = z.object({
  text: z.string().min(1).max(100_000),
  parentId: boundedId.optional(),
  source: z.record(z.string().max(100), z.string().max(2_000))
    .refine((value) => Object.keys(value).length <= 20, 'source has too many entries')
    .optional(),
  clientCreatedAt: z.iso.datetime({ offset: true }).optional(),
}).strict()

export type NotesCreateRequest = z.infer<typeof notesCreateRequestSchema>

export const notesCreateResponseSchema = z.object({
  noteId: boundedId,
  eventId: boundedId,
  revision,
  parentId: boundedId,
  origin: z.literal('notes_api'),
  createdAt: z.iso.datetime({ offset: true }),
}).strict()

export type NotesCreateResponse = z.infer<typeof notesCreateResponseSchema>

export const checkpointBootstrapResponseSchema = z.object({
  checkpoint: z.object({
    id: boundedId,
    outlineId: boundedId,
    documentVersion: z.number().int().positive(),
    schemaEpoch: z.number().int().positive(),
    revision,
    integrityHash: z.string().regex(/^[a-f0-9]{64}$/),
    state: z.record(z.string(), z.unknown()),
  }).strict(),
}).strict()

export const claimOutlineRequestSchema = z.object({
  outlineId: boundedId,
  name: z.string().trim().min(1).max(200),
}).strict()

export const claimOutlineResponseSchema = z.object({
  outlineId: boundedId,
  state: z.enum(['seeding', 'ready']),
}).strict()

export const outlineStateSchema = z.object({
  doc: z.record(z.string(), z.unknown()),
  trash: z.array(z.record(z.string(), z.unknown())),
  shortcuts: z.array(z.record(z.string(), z.unknown())),
  schemaEpoch: z.number().int().positive(),
}).strict()

export const seedOutlineRequestSchema = z.object({
  state: outlineStateSchema,
}).strict()

export const seedOutlineResponseSchema = z.object({
  outlineId: boundedId,
  revision,
  integrityHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()

export const pullEventsQuerySchema = z.object({
  afterRevision: z.coerce.number().int().nonnegative(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
}).strict()

export const pullEventsResponseSchema = z.object({
  events: z.array(eventEnvelopeSchema).max(100),
  currentRevision: revision,
  nextAfterRevision: revision.nullable(),
}).strict()

export const pushEventsRequestSchema = z.object({
  baseRevision: revision,
  events: z.array(eventEnvelopeSchema).min(1).max(100),
}).strict()

const acknowledgementSchema = z.object({
  eventId: boundedId,
  revision,
}).strict()

export const pushEventsResponseSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('accepted'),
    acknowledgements: z.array(acknowledgementSchema).min(1).max(100),
    currentRevision: revision,
  }).strict(),
  z.object({
    status: z.literal('rebase_required'),
    currentRevision: revision,
    pullAfterRevision: revision,
  }).strict(),
])

export const protocolErrorCodeSchema = z.enum([
  'authentication_required',
  'authorization_denied',
  'upgrade_required',
  'conflict',
  'invalid_request',
  'request_too_large',
  'dependency_unavailable',
  'idempotency_conflict',
  'outline_not_synchronized',
  'source_missing',
  'source_trashed',
  'target_missing',
  'target_trashed',
  'configuration_unavailable',
  'configuration_conflict',
  'compute_unavailable',
  'capability_unavailable',
  'projection_rebuilding',
  'worker_unavailable',
])

export const protocolErrorSchema = z.object({
  error: z.object({
    code: protocolErrorCodeSchema,
    message: z.string().min(1).max(1_000),
    retryable: z.boolean(),
    recoveryAction: z.string().trim().min(1).max(100).optional(),
  }).strict(),
}).strict()

export const serverStatusSchema = z.object({
  instanceId: boundedId,
  apiVersions: z.array(z.number().int().positive()).min(1),
  eventVersions: z.record(z.string(), z.array(z.number().int().positive()).min(1)),
  agentOriginVersions: z.array(z.number().int().positive()).min(1),
  minimumAgentClientVersion: z.string().trim().min(1).max(50),
  documentSchemaVersion: z.number().int().positive(),
  minimumClientVersion: z.string().trim().min(1).max(50),
  agentAdmissionVersions: z.array(z.number().int().positive()).min(1).optional(),
  streamVersions: z.array(z.number().int().positive()).min(1).optional(),
}).strict()

export const outlineStreamClientFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), afterRevision: revision, deviceId: boundedId }).strict(),
  z.object({ type: z.literal('ping') }).strict(),
])

/** Frames the server may send on the outline stream. */
export const outlineStreamServerFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), currentRevision: revision }).strict(),
  z.object({
    type: z.literal('events'),
    fromRevision: revision,
    toRevision: revision,
    events: z.array(eventEnvelopeSchema).min(1).max(200),
  }).strict(),
  z.object({ type: z.literal('resync'), currentRevision: revision }).strict(),
  z.object({
    type: z.literal('agent'),
    runId: boundedId,
    activitySeq: z.number().int().nonnegative(),
    status: z.string().trim().min(1).max(50),
  }).strict(),
  z.object({ type: z.literal('pong') }).strict(),
])

export type OutlineStreamServerFrame = z.infer<typeof outlineStreamServerFrameSchema>

export type ServerStatus = z.infer<typeof serverStatusSchema>

export const assetIdSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const assetMediaTypeSchema = z.enum(['image/png', 'image/jpeg', 'image/webp'])

export const assetInitiateRequestSchema = z.object({
  assetId: assetIdSchema,
  mediaType: assetMediaTypeSchema,
  byteSize: z.number().int().min(1).max(5 * 1024 * 1024),
}).strict()

export const assetCompleteRequestSchema = z.object({
  bytesBase64: z.string().min(1).max(7_000_000),
}).strict()

export const assetTransferResponseSchema = z.object({
  assetId: assetIdSchema,
  mediaType: assetMediaTypeSchema,
  byteSize: z.number().int().positive(),
  status: z.enum(['upload_required', 'complete']),
}).strict()

export const assetDownloadResponseSchema = assetTransferResponseSchema.omit({ status: true }).extend({
  bytesBase64: z.string().min(1),
}).strict()
