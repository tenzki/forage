import { z } from 'zod'
import { eventEnvelopeSchema } from '../../domain/src'

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
])

export const protocolErrorSchema = z.object({
  error: z.object({
    code: protocolErrorCodeSchema,
    message: z.string().min(1).max(1_000),
    retryable: z.boolean(),
  }).strict(),
}).strict()

export const serverStatusSchema = z.object({
  instanceId: boundedId,
  apiVersions: z.array(z.number().int().positive()).min(1),
  eventVersions: z.record(z.string(), z.array(z.number().int().positive()).min(1)),
  documentSchemaVersion: z.number().int().positive(),
  minimumClientVersion: z.string().trim().min(1).max(50),
}).strict()

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
