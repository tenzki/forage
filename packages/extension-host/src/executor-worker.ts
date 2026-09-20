import {
  extensionCatalogEntrySchema,
  extensionExecutorIdSchema,
  extensionJsonObjectSchema,
  extensionSkillAdmittedPlanSchema,
  extensionSkillContextSnapshotSchema,
  extensionSourceConfigurationSchema,
  runtimeIdSchema,
  type ExtensionCatalogEntry,
  type ExtensionJsonObject,
  type ExtensionSkillAdmittedPlan,
  type ExtensionSkillContextSnapshot,
  type ExtensionSourceConfiguration,
} from '@forage/agent-runtime'
import type {
  ExtensionSkillConfigurationValidation,
  ExtensionSkillPreparedPlan,
  ExtensionSkillResult,
} from '@forage/extension-api'
import {
  ExtensionRuntimeError,
  loadForageExtension,
  sanitizeExtensionText,
  type ExtensionRuntimeLog,
} from './runtime'

export type ExtensionExecutorWorkerOperation = 'validate' | 'prepare' | 'execute'

interface ExtensionExecutorWorkerRequestBase {
  requestId: string
  operation: ExtensionExecutorWorkerOperation
  entry: ExtensionCatalogEntry
  sourceConfiguration: ExtensionSourceConfiguration
  executorId: string
}

export type ExtensionExecutorWorkerRequest =
  | ExtensionExecutorWorkerRequestBase & {
    operation: 'validate'
    input: { configuration: ExtensionJsonObject }
  }
  | ExtensionExecutorWorkerRequestBase & {
    operation: 'prepare'
    input: {
      runId: string
      configuration: ExtensionJsonObject
      context: ExtensionSkillContextSnapshot
    }
  }
  | ExtensionExecutorWorkerRequestBase & {
    operation: 'execute'
    input: {
      runId: string
      configuration: ExtensionJsonObject
      context: ExtensionSkillContextSnapshot
      plan: ExtensionSkillAdmittedPlan
    }
    secrets: Readonly<Record<string, string | undefined>>
  }

export type ExtensionExecutorWorkerEvent =
  | { requestId: string; type: 'log'; value: ExtensionRuntimeLog }
  | { requestId: string; type: 'progress'; value: unknown }
  | {
    requestId: string
    type: 'result'
    operation: 'validate'
    value: ExtensionSkillConfigurationValidation
  }
  | {
    requestId: string
    type: 'result'
    operation: 'prepare'
    value: ExtensionSkillPreparedPlan
  }
  | {
    requestId: string
    type: 'result'
    operation: 'execute'
    value: ExtensionSkillResult
  }
  | { requestId: string; type: 'error'; code: string; message: string }

export function parseExtensionExecutorWorkerRequest(value: unknown): ExtensionExecutorWorkerRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Executor worker request must be an object.')
  const request = value as Record<string, unknown>
  const requestId = runtimeIdSchema.parse(request.requestId)
  const operation = request.operation
  if (operation !== 'validate' && operation !== 'prepare' && operation !== 'execute') {
    throw new Error('Executor worker request has an unsupported operation.')
  }
  const entry = extensionCatalogEntrySchema.parse(request.entry)
  const sourceConfiguration = extensionSourceConfigurationSchema.parse(request.sourceConfiguration)
  const executorId = extensionExecutorIdSchema.parse(request.executorId)
  if (!request.input || typeof request.input !== 'object' || Array.isArray(request.input)) {
    throw new Error('Executor worker input must be an object.')
  }
  const input = request.input as Record<string, unknown>
  const configuration = extensionJsonObjectSchema.parse(input.configuration)
  if (operation === 'validate') {
    return { requestId, operation, entry, sourceConfiguration, executorId, input: { configuration } }
  }
  const runId = runtimeIdSchema.parse(input.runId)
  const context = extensionSkillContextSnapshotSchema.parse(input.context)
  if (operation === 'prepare') {
    return { requestId, operation, entry, sourceConfiguration, executorId, input: { runId, configuration, context } }
  }
  const plan = extensionSkillAdmittedPlanSchema.parse(input.plan)
  const rawSecrets = request.secrets
  if (!rawSecrets || typeof rawSecrets !== 'object' || Array.isArray(rawSecrets)) {
    throw new Error('Executor execution secrets must be an object.')
  }
  const secrets = Object.fromEntries(Object.entries(rawSecrets).map(([key, secret]) => {
    if (typeof secret !== 'string' && secret !== undefined) throw new Error('Executor secrets must be strings.')
    return [key, secret]
  }))
  return {
    requestId,
    operation,
    entry,
    sourceConfiguration,
    executorId,
    input: { runId, configuration, context, plan },
    secrets,
  }
}

export async function runExtensionExecutorWorkerRequest(
  rawRequest: unknown,
  signal: AbortSignal,
  emit: (event: ExtensionExecutorWorkerEvent) => void,
): Promise<void> {
  let request: ExtensionExecutorWorkerRequest
  try {
    request = parseExtensionExecutorWorkerRequest(rawRequest)
  } catch (error) {
    throw new ExtensionRuntimeError('invalid_executor_worker_request', boundedMessage(error))
  }
  const secretValues = request.operation === 'execute'
    ? Object.values(request.secrets).filter((value): value is string => Boolean(value))
    : []
  try {
    const loaded = await loadForageExtension(request.entry, {
      configuration: request.sourceConfiguration,
      cacheKey: request.entry.provenance?.entryDigest,
      stderr: (line) => process.stderr.write(`${sanitizeExtensionText(line, secretValues)}\n`),
    })
    const options = {
      signal,
      ...(request.operation === 'execute' ? { secrets: request.secrets } : {}),
      onLog: (value: ExtensionRuntimeLog) => emit({ requestId: request.requestId, type: 'log', value }),
      onProgress: (value: unknown) => emit({ requestId: request.requestId, type: 'progress', value }),
    }
    if (request.operation === 'validate') {
      const value = await loaded.validateExecutorConfiguration(request.executorId, request.input, options)
      emit({ requestId: request.requestId, type: 'result', operation: request.operation, value })
      return
    }
    if (request.operation === 'prepare') {
      const value = await loaded.prepareExecutor(request.executorId, request.input, options)
      emit({ requestId: request.requestId, type: 'result', operation: request.operation, value })
      return
    }
    const value = await loaded.executeExecutor(request.executorId, request.input, options)
    emit({ requestId: request.requestId, type: 'result', operation: request.operation, value })
  } catch (error) {
    emit({
      requestId: request.requestId,
      type: 'error',
      code: error instanceof ExtensionRuntimeError ? error.code : 'executor_worker_failed',
      message: sanitizeExtensionText(boundedMessage(error), secretValues),
    })
  }
}

function boundedMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000) || 'Extension executor worker failed.'
}
