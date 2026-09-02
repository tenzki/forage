import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  agentActivityPageSchema,
  agentActivityQuerySchema,
  agentConfigurationPublishRequestSchema,
  agentConfigurationResponseSchema,
  agentRunAdmissionRequestSchema,
  agentRunAdmissionResponseSchema,
  agentRunCancelResponseSchema,
  agentRunDetailSchema,
  agentRunListQuerySchema,
  agentRunListResponseSchema,
  agentRunRetryResponseSchema,
  apiKeyEnrollmentRequestSchema,
  automationPolicyPublishRequestSchema,
  notesCreateRequestSchema,
  assetCompleteRequestSchema,
  assetDownloadResponseSchema,
  assetInitiateRequestSchema,
  assetTransferResponseSchema,
  pullEventsQuerySchema,
  pushEventsRequestSchema,
  serverStatusSchema,
} from '@forage/protocol'
import { AgentRuntimeError, resolveEffectiveToolIds, type AgentConfiguration, type RunInput } from '@forage/agent-runtime'
import type { ServerRepository, TokenScope } from './repository.js'
import { RepositoryError } from './repository.js'
import { AgentStoreError, type AgentRunRecord } from './agentStore.js'
import { CredentialServiceError, type ServerCredentialService } from './credentialService.js'
import type { AssetStorage } from './assets.js'
import { verifyAssetBytes } from './assets.js'
import { redactSecrets } from './credentialCrypto.js'

export interface ServerOptions {
  repository: ServerRepository
  assetStorage: AssetStorage
  logger?: FastifyServerOptions['logger']
  credentialService?: ServerCredentialService
  supportedAgentToolIds?: string[]
  agentMaxAttempts?: number
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
    const failure = error instanceof Error
      ? { name: error.name.slice(0, 100), message: redactSecrets(error.message).slice(0, 1_000) }
      : { name: 'Error', message: 'Unknown server failure.' }
    request.log.error({ failure }, 'Request failed')
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
    agentOriginVersions: [1],
    minimumAgentClientVersion: '0.1.0',
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

  app.get('/api/v1/outlines/:outlineId/agent-configuration', async (request, reply) => {
    try {
      const principal = await authorizeOutline(repository, request.headers.authorization, 'agents:read', request.params)
      const current = await repository.agentStore.currentConfiguration(principal.outlineId)
      if (!current) throw new RepositoryError('conflict', 'No server agent configuration has been published.')
      return agentConfigurationResponseSchema.parse(current)
    } catch (error) { return sendError(reply, error) }
  })

  app.put('/api/v1/outlines/:outlineId/agent-configuration', async (request, reply) => {
    try {
      const principal = await authorizeOutline(repository, request.headers.authorization, 'agents:manage', request.params)
      const body = agentConfigurationPublishRequestSchema.parse(request.body)
      validateServerConfiguration(body.configuration, options.supportedAgentToolIds ?? [])
      const published = await repository.agentStore.publishConfiguration(principal.outlineId, body.baseRevision, body.configuration, principal.tokenId)
      return agentConfigurationResponseSchema.parse(published)
    } catch (error) { return sendError(reply, error) }
  })

  app.get('/api/v1/outlines/:outlineId/agent-automation', async (request, reply) => {
    try {
      const principal = await authorizeOutline(repository, request.headers.authorization, 'agents:read', request.params)
      return { published: await repository.agentStore.currentAutomation(principal.outlineId) }
    } catch (error) { return sendError(reply, error) }
  })

  app.put('/api/v1/outlines/:outlineId/agent-automation', async (request, reply) => {
    try {
      const principal = await authorizeOutline(repository, request.headers.authorization, 'agents:manage', request.params)
      const body = automationPolicyPublishRequestSchema.parse(request.body)
      const configuration = await requireConfiguration(repository, principal.outlineId)
      const skillIds = new Set(configuration.skills.map((skill) => skill.id))
      const agentIds = new Set(configuration.agents.map((agent) => agent.id))
      for (const policy of body.policies.policies) {
        if (policy.skillIds.some((skillId) => !skillIds.has(skillId))) throw new RepositoryError('conflict', 'Automation policy references an unavailable skill.')
        if (policy.dispatcher.agentId && !agentIds.has(policy.dispatcher.agentId)) throw new RepositoryError('conflict', 'Automation dispatcher references an unavailable agent.')
      }
      return repository.agentStore.publishAutomation(principal.outlineId, body.baseRevision, body.policies, principal.tokenId)
    } catch (error) { return sendError(reply, error) }
  })

  app.post('/api/v1/outlines/:outlineId/agent-credentials/api-key', async (request, reply) => {
    try {
      const principal = await authorizeOutline(repository, request.headers.authorization, 'agents:manage', request.params)
      const body = apiKeyEnrollmentRequestSchema.parse(request.body)
      return reply.code(201).send(await requireCredentialService(options).enrollApiKey(principal.ownerId, principal.outlineId, body.apiKey))
    } catch (error) { return sendError(reply, error) }
  })

  app.post('/api/v1/outlines/:outlineId/agent-credentials/chatgpt/device', async (request, reply) => {
    try {
      const principal = await authorizeOutline(repository, request.headers.authorization, 'agents:manage', request.params)
      return reply.code(201).send(await requireCredentialService(options).startDeviceAuthorization(principal.ownerId, principal.outlineId))
    } catch (error) { return sendError(reply, error) }
  })

  app.get('/api/v1/outlines/:outlineId/agent-device-authorizations/:authorizationId', async (request, reply) => {
    try {
      const principal = await authorizeOutline(repository, request.headers.authorization, 'agents:manage', request.params)
      const authorizationId = routeIdentifier(request.params, 'authorizationId')
      return await requireCredentialService(options).pollDeviceAuthorization(authorizationId, principal.ownerId, principal.outlineId)
    } catch (error) { return sendError(reply, error) }
  })

  app.get('/api/v1/outlines/:outlineId/agent-credentials/:credentialId', async (request, reply) => {
    try {
      const principal = await authorizeOutline(repository, request.headers.authorization, 'agents:read', request.params)
      return await requireCredentialService(options).metadata(routeIdentifier(request.params, 'credentialId'), principal.ownerId, principal.outlineId)
    } catch (error) { return sendError(reply, error) }
  })

  app.delete('/api/v1/outlines/:outlineId/agent-credentials/:credentialId', async (request, reply) => {
    try {
      const principal = await authorizeOutline(repository, request.headers.authorization, 'agents:manage', request.params)
      return await requireCredentialService(options).disconnect(routeIdentifier(request.params, 'credentialId'), principal.ownerId, principal.outlineId)
    } catch (error) { return sendError(reply, error) }
  })

  app.post('/api/v1/outlines/:outlineId/agent-runs', async (request, reply) => {
    try {
      const principal = await authorizeOutline(repository, request.headers.authorization, 'agents:execute', request.params)
      const key = idempotencyKey(request.headers['idempotency-key'])
      const body = agentRunAdmissionRequestSchema.parse(request.body)
      const input = await makeRunInput(repository, options, principal, body)
      const run = await repository.agentStore.admitRun({
        input, ownerId: principal.ownerId, trigger: 'manual', triggerIdentity: `manual:${principal.tokenId}:${key}`,
        maxAttempts: options.agentMaxAttempts ?? 3,
      })
      return reply.code(202).send(agentRunAdmissionResponseSchema.parse({ runId: run.id, status: 'queued', admittedAt: run.admittedAt }))
    } catch (error) { return sendError(reply, error) }
  })

  app.get('/api/v1/outlines/:outlineId/agent-runs', async (request, reply) => {
    try {
      const principal = await authorizeOutline(repository, request.headers.authorization, 'agents:read', request.params)
      const query = agentRunListQuerySchema.parse(request.query)
      const runs = await repository.agentStore.listRuns(principal.outlineId, query.limit, query.cursor, query.status)
      return agentRunListResponseSchema.parse({
        runs: runs.map(runSummary), nextCursor: runs.length === query.limit ? runs.at(-1)!.admittedAt : null,
      })
    } catch (error) { return sendError(reply, error) }
  })

  app.get('/api/v1/outlines/:outlineId/agent-runs/:runId', async (request, reply) => {
    try {
      const principal = await authorizeOutline(repository, request.headers.authorization, 'agents:read', request.params)
      const run = await repository.agentStore.getRun(principal.outlineId, routeIdentifier(request.params, 'runId'))
      if (!run) throw new RepositoryError('authorization_denied', 'The requested resource is unavailable.')
      return agentRunDetailSchema.parse(runDetail(run))
    } catch (error) { return sendError(reply, error) }
  })

  app.get('/api/v1/outlines/:outlineId/agent-runs/:runId/activity', async (request, reply) => {
    try {
      const principal = await authorizeOutline(repository, request.headers.authorization, 'agents:read', request.params)
      const runId = routeIdentifier(request.params, 'runId')
      if (!await repository.agentStore.getRun(principal.outlineId, runId)) throw new RepositoryError('authorization_denied', 'The requested resource is unavailable.')
      const query = agentActivityQuerySchema.parse(request.query)
      const page = await repository.agentStore.activity(runId, query.afterSequence, query.limit)
      return agentActivityPageSchema.parse({
        ...page, nextCursor: page.events.length === query.limit ? String(page.events.at(-1)!.sequence) : null,
      })
    } catch (error) { return sendError(reply, error) }
  })

  app.post('/api/v1/outlines/:outlineId/agent-runs/:runId/cancel', async (request, reply) => {
    try {
      const principal = await authorizeOutline(repository, request.headers.authorization, 'agents:execute', request.params)
      const run = await repository.agentStore.requestCancellation(principal.outlineId, routeIdentifier(request.params, 'runId'), new Date())
      return agentRunCancelResponseSchema.parse({ runId: run.id, status: run.status })
    } catch (error) { return sendError(reply, error) }
  })

  app.post('/api/v1/outlines/:outlineId/agent-runs/:runId/retry', async (request, reply) => {
    try {
      const principal = await authorizeOutline(repository, request.headers.authorization, 'agents:execute', request.params)
      const runId = routeIdentifier(request.params, 'runId')
      const previous = await repository.agentStore.getRun(principal.outlineId, runId)
      if (!previous) throw new RepositoryError('authorization_denied', 'The requested resource is unavailable.')
      const configuration = await requireConfiguration(repository, principal.outlineId)
      const context = await repository.runAdmissionContext(principal, previous.input.source.nodeId ?? '', previous.input.target.parentId)
      const input = buildInputFromConfiguration(options, configuration, {
        ...previous.input, runId: `run_${randomUUID()}`, baseRevision: context.baseRevision,
        configurationRevision: configuration.revision, source: { ...previous.input.source, text: context.sourceText }, context: context.context,
      }, previous.skillId, previous.credentialReference)
      const retry = await repository.agentStore.retry(principal.outlineId, runId, input, options.agentMaxAttempts ?? 3)
      return agentRunRetryResponseSchema.parse({ runId: retry.id, retryOfRunId: runId, status: 'queued' })
    } catch (error) { return sendError(reply, error) }
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

async function authorizeOutline(repository: ServerRepository, authorization: string | undefined, scope: TokenScope, params: unknown) {
  const principal = await authorize(repository, authorization, scope)
  if (routeOutlineId(params) !== principal.outlineId) throw new RepositoryError('authorization_denied', 'The requested resource is unavailable.')
  return principal
}

function routeIdentifier(params: unknown, key: string): string {
  return z.object({ [key]: z.string().trim().min(1).max(128) }).passthrough().parse(params)[key]!
}

function requireCredentialService(options: ServerOptions): ServerCredentialService {
  if (!options.credentialService) throw new RepositoryError('conflict', 'Server credential providers are not configured.')
  return options.credentialService
}

async function requireConfiguration(repository: ServerRepository, outlineId: string, revision?: number): Promise<AgentConfiguration> {
  const published = await repository.agentStore.currentConfiguration(outlineId)
  if (!published || (revision !== undefined && published.configuration.revision !== revision)) {
    throw new RepositoryError('conflict', 'The requested agent configuration revision is unavailable.')
  }
  return published.configuration
}

function validateServerConfiguration(configuration: AgentConfiguration, supportedToolIds: string[]): void {
  for (const skill of configuration.skills) {
    const agent = configuration.agents.find((candidate) => candidate.id === skill.agentId)!
    try {
      resolveEffectiveToolIds({
        agentToolIds: agent.toolIds, requiredToolIds: skill.requiredToolIds,
        globallyEnabledToolIds: configuration.globallyEnabledToolIds,
        policyAllowedToolIds: configuration.globallyEnabledToolIds,
        executorSupportedToolIds: supportedToolIds,
      })
    } catch (error) {
      if (error instanceof AgentRuntimeError) throw new RepositoryError('conflict', error.message)
      throw error
    }
  }
}

async function makeRunInput(
  repository: ServerRepository,
  options: ServerOptions,
  principal: Awaited<ReturnType<typeof authorize>>,
  body: z.infer<typeof agentRunAdmissionRequestSchema>,
): Promise<RunInput> {
  const configuration = await requireConfiguration(repository, principal.outlineId, body.configurationRevision)
  const skill = configuration.skills.find((candidate) => candidate.id === body.skillId)
  const agent = skill ? configuration.agents.find((candidate) => candidate.id === skill.agentId) : undefined
  if (!skill || !agent) throw new RepositoryError('conflict', 'The selected skill is unavailable.')
  const credentialRef = body.credentialRef ?? agent.credentialRef
  if (!credentialRef) throw new RepositoryError('conflict', 'The selected agent has no server credential reference.')
  const credential = await requireCredentialService(options).metadata(credentialRef, principal.ownerId, principal.outlineId)
  if (credential.status !== 'connected') throw new RepositoryError('authentication_required', 'Provider authentication is required.')
  const context = await repository.runAdmissionContext(principal, body.sourceNodeId, body.targetParentId)
  return buildInputFromConfiguration(options, configuration, {
    version: 1, runId: `run_${randomUUID()}`, executionMode: 'server', outlineId: principal.outlineId,
    source: { nodeId: body.sourceNodeId, text: context.sourceText }, target: { parentId: body.targetParentId },
    baseRevision: context.baseRevision, configurationRevision: configuration.revision, credentialRef,
    agent, skill, effectiveToolIds: [], prompt: body.prompt, context: context.context,
    customTools: configuration.customTools,
  }, skill.id, credentialRef)
}

function buildInputFromConfiguration(
  options: ServerOptions,
  configuration: AgentConfiguration,
  base: RunInput,
  skillId: string,
  credentialRef: string,
): RunInput {
  const skill = configuration.skills.find((candidate) => candidate.id === skillId)
  const agent = skill ? configuration.agents.find((candidate) => candidate.id === skill.agentId) : undefined
  if (!skill || !agent) throw new RepositoryError('conflict', 'The selected skill is unavailable in the current configuration.')
  let effectiveToolIds: string[]
  try {
    effectiveToolIds = resolveEffectiveToolIds({
      agentToolIds: agent.toolIds, requiredToolIds: skill.requiredToolIds,
      globallyEnabledToolIds: configuration.globallyEnabledToolIds,
      policyAllowedToolIds: configuration.globallyEnabledToolIds,
      executorSupportedToolIds: options.supportedAgentToolIds ?? [],
    })
  } catch (error) {
    if (error instanceof AgentRuntimeError) throw new RepositoryError('conflict', error.message)
    throw error
  }
  return {
    ...base, configurationRevision: configuration.revision, credentialRef, agent, skill, effectiveToolIds,
    customTools: configuration.customTools,
  }
}

function runSummary(run: AgentRunRecord) {
  return {
    id: run.id, outlineId: run.outlineId, trigger: run.trigger, status: run.status,
    skillId: run.skillId, policyId: run.policyId, configurationRevision: run.configurationRevision, attemptCount: run.attemptCount,
    admittedAt: run.admittedAt, updatedAt: run.updatedAt, retryOfRunId: run.retryOfRunId,
  }
}

function runDetail(run: AgentRunRecord) {
  return {
    ...runSummary(run),
    error: run.errorCode ? publicRunError(run.errorCode) : null,
    result: run.result,
  }
}

function publicRunError(code: string) {
  const allowed = new Set([
    'authentication_required', 'dependency_unavailable', 'provider_rate_limited', 'timeout', 'unsupported_tool',
    'invalid_input', 'invalid_output', 'target_unavailable', 'attempts_exhausted', 'lease_lost',
  ])
  const publicCode = allowed.has(code) ? code : 'dependency_unavailable'
  return { code: publicCode, message: publicCode.replaceAll('_', ' '), retryable: ['dependency_unavailable', 'provider_rate_limited', 'timeout', 'lease_lost'].includes(publicCode) }
}

function sendError(reply: { code: (status: number) => { send: (body: unknown) => unknown } }, error: unknown) {
  if (error instanceof AgentStoreError) {
    const status = error.code === 'not_found' ? 403 : 409
    return reply.code(status).send({ error: { code: error.code === 'not_found' ? 'authorization_denied' : 'conflict', message: error.message, retryable: false } })
  }
  if (error instanceof CredentialServiceError) {
    const status = error.code === 'authentication_required' ? 401 : 409
    return reply.code(status).send({ error: { code: error.code === 'authentication_required' ? error.code : 'conflict', message: error.message, retryable: false } })
  }
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
