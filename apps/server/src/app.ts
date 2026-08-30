import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify'
import { z } from 'zod'
import {
  notesCreateRequestSchema,
  assetCompleteRequestSchema,
  assetDownloadResponseSchema,
  assetInitiateRequestSchema,
  assetTransferResponseSchema,
  pullEventsQuerySchema,
  pushEventsRequestSchema,
  serverStatusSchema,
} from '@forage/protocol'
import type { ServerRepository, TokenScope } from './repository.js'
import { RepositoryError } from './repository.js'
import type { AssetStorage } from './assets.js'
import { verifyAssetBytes } from './assets.js'

export interface ServerOptions {
  repository: ServerRepository
  assetStorage: AssetStorage
  logger?: FastifyServerOptions['logger']
}

export function buildServer(options: ServerOptions): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? true, bodyLimit: 7_500_000 })
  const { repository } = options

  app.get('/health/live', async () => ({ status: 'live' }))
  app.get('/health/ready', async (_request, reply) => {
    if (!(await repository.ready()) || !(await options.assetStorage.ready())) return reply.code(503).send({ status: 'not_ready' })
    return { status: 'ready' }
  })

  app.setErrorHandler((error, request, reply) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.code(413).send({ error: { code: 'request_too_large', message: 'Request body is too large.', retryable: false } })
    }
    request.log.error(error)
    return reply.code(500).send({ error: { code: 'dependency_unavailable', message: 'A required server dependency is unavailable.', retryable: true } })
  })
  app.get('/api/v1/status', async () => serverStatusSchema.parse({
    instanceId: repository.instanceId,
    apiVersions: [1],
    eventVersions: {
      'document.steps_applied': [1], 'document.undo_applied': [1], 'document.redo_applied': [1],
      'note.created': [1], 'trash.entry_added': [1], 'trash.entry_restored': [1],
      'trash.entry_purged': [1], 'shortcut.created': [1], 'shortcut.updated': [1],
      'shortcut.deleted': [1], 'shortcuts.reordered': [1], 'asset.reference_added': [1],
      'document.schema_migrated': [1],
    },
    documentSchemaVersion: 1,
    minimumClientVersion: '0.1.0',
  }))

  app.post('/api/v1/notes', async (request, reply) => {
    try {
      const principal = await authorize(repository, request.headers.authorization, 'notes:create')
      const key = idempotencyKey(request.headers['idempotency-key'])
      const input = notesCreateRequestSchema.parse(request.body)
      const result = await repository.createNote(principal, key, input)
      reply.header('location', `/api/v1/notes/${result.response.noteId}`)
      return reply.code(result.replayed ? 200 : 201).send(result.response)
    } catch (error) {
      return sendError(reply, error)
    }
  })

  app.get('/api/v1/outlines/:outlineId/checkpoint', async (request, reply) => {
    try {
      const principal = await authorize(repository, request.headers.authorization, 'sync')
      const outlineId = routeOutlineId(request.params)
      if (outlineId !== principal.outlineId) throw new RepositoryError('authorization_denied', 'The requested resource is unavailable.')
      return { checkpoint: await repository.checkpoint(outlineId) }
    } catch (error) { return sendError(reply, error) }
  })

  app.get('/api/v1/outlines/:outlineId/events', async (request, reply) => {
    try {
      const principal = await authorize(repository, request.headers.authorization, 'sync')
      const outlineId = routeOutlineId(request.params)
      if (outlineId !== principal.outlineId) throw new RepositoryError('authorization_denied', 'The requested resource is unavailable.')
      const query = pullEventsQuerySchema.parse(request.query)
      const events = await repository.eventsAfter(outlineId, query.afterRevision, query.limit)
      const currentRevision = await repository.currentRevision(outlineId)
      const last = events.at(-1)?.revision ?? query.afterRevision
      return { events, currentRevision, nextAfterRevision: last < currentRevision ? last : null }
    } catch (error) { return sendError(reply, error) }
  })

  app.post('/api/v1/outlines/:outlineId/events', async (request, reply) => {
    try {
      const principal = await authorize(repository, request.headers.authorization, 'sync')
      const outlineId = routeOutlineId(request.params)
      if (outlineId !== principal.outlineId) throw new RepositoryError('authorization_denied', 'The requested resource is unavailable.')
      const baseRevision = z.object({ baseRevision: z.number().int().nonnegative() }).passthrough().parse(request.body).baseRevision
      const currentRevision = await repository.currentRevision(outlineId)
      if (baseRevision !== currentRevision) {
        return reply.code(409).send({ status: 'rebase_required', currentRevision, pullAfterRevision: baseRevision })
      }
      const body = pushEventsRequestSchema.parse(request.body)
      const acknowledgements = await repository.acceptEvents(principal, body.baseRevision, body.events)
      return { status: 'accepted', acknowledgements, currentRevision: await repository.currentRevision(outlineId) }
    } catch (error) { return sendError(reply, error) }
  })

  app.post('/api/v1/assets/initiate', async (request, reply) => {
    try {
      const principal = await authorize(repository, request.headers.authorization, 'sync')
      const input = assetInitiateRequestSchema.parse(request.body)
      const record = await repository.initiateAsset(principal, input)
      return assetTransferResponseSchema.parse({
        assetId: record.assetId, mediaType: record.mediaType, byteSize: record.byteSize,
        status: record.completed ? 'complete' : 'upload_required',
      })
    } catch (error) { return sendError(reply, error) }
  })

  app.post('/api/v1/assets/:assetId/complete', async (request, reply) => {
    try {
      const principal = await authorize(repository, request.headers.authorization, 'sync')
      const assetId = routeAssetId(request.params)
      const pending = await repository.initiateAsset(principal, {
        assetId,
        mediaType: z.object({ mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp']) }).passthrough().parse(request.body).mediaType,
        byteSize: z.object({ byteSize: z.number().int().positive().max(5 * 1024 * 1024) }).passthrough().parse(request.body).byteSize,
      })
      if (pending.completed) return assetTransferResponseSchema.parse({
        assetId: pending.assetId, mediaType: pending.mediaType, byteSize: pending.byteSize, status: 'complete',
      })
      const body = assetCompleteRequestSchema.extend({
        mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
        byteSize: z.number().int().positive().max(5 * 1024 * 1024),
      }).strict().parse(request.body)
      const bytes = Buffer.from(body.bytesBase64, 'base64')
      let verified
      try { verified = await verifyAssetBytes(bytes, pending.mediaType) }
      catch (error) {
        throw new z.ZodError([{ code: 'custom', path: ['bytesBase64'], message: error instanceof Error ? error.message : 'Invalid asset bytes.' }])
      }
      if (verified.assetId !== assetId || verified.byteSize !== pending.byteSize) {
        throw new RepositoryError('conflict', 'Uploaded bytes do not match initiated asset metadata.')
      }
      const stored = await options.assetStorage.putVerified(assetId, bytes)
      const completed = await repository.completeAsset(principal, assetId, stored.storageKey)
      return assetTransferResponseSchema.parse({
        assetId: completed.assetId, mediaType: completed.mediaType, byteSize: completed.byteSize, status: 'complete',
      })
    } catch (error) { return sendError(reply, error) }
  })

  app.get('/api/v1/assets/:assetId', async (request, reply) => {
    try {
      const principal = await authorize(repository, request.headers.authorization, 'sync')
      const assetId = routeAssetId(request.params)
      const record = await repository.asset(principal, assetId)
      const bytes = await options.assetStorage.read(assetId)
      return assetDownloadResponseSchema.parse({
        assetId, mediaType: record.mediaType, byteSize: record.byteSize,
        bytesBase64: bytes.toString('base64'),
      })
    } catch (error) { return sendError(reply, error) }
  })

  return app
}


async function authorize(repository: ServerRepository, authorization: string | undefined, scope: TokenScope) {
  const match = /^Bearer (\S+)$/.exec(authorization ?? '')
  if (!match) throw new RepositoryError('authentication_required', 'Authentication is required.')
  return repository.authenticate(match[1], scope)
}

function idempotencyKey(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 255) {
    throw new z.ZodError([{ code: 'custom', path: ['Idempotency-Key'], message: 'Idempotency-Key is required.' }])
  }
  return value
}

function routeOutlineId(params: unknown): string {
  return z.object({ outlineId: z.string().min(1).max(128) }).parse(params).outlineId
}

function routeAssetId(params: unknown): string {
  return z.object({ assetId: z.string().regex(/^[a-f0-9]{64}$/) }).parse(params).assetId
}

function sendError(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, error: unknown) {
  if (error instanceof RepositoryError) {
    const status = error.code === 'authentication_required' ? 401
      : error.code === 'authorization_denied' ? 403
        : error.code === 'upgrade_required' ? 426 : 409
    return reply.code(status).send({ error: { code: error.code, message: error.message, retryable: false } })
  }
  if (error instanceof z.ZodError) {
    return reply.code(400).send({ error: { code: 'invalid_request', message: error.issues[0]?.message ?? 'Invalid request.', retryable: false } })
  }
  throw error
}
