import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  extensionLogEntrySchema,
  extensionProgressSchema,
  extensionSkillPreparedPlanSchema,
  parseStructuredResult,
  type ExtensionCatalogEntry,
  type ExtensionSourceConfiguration,
} from '@forage/agent-runtime'
import type {
  ExtensionLogEntry,
  ExtensionProgress,
  ExtensionSkillConfigurationValidation,
  ExtensionSkillExecutionInput,
  ExtensionSkillPreparationInput,
  ExtensionSkillPreparedPlan,
  ExtensionSkillResult,
  ExtensionSkillValidationInput,
} from '@forage/extension-api'
import { sanitizeExtensionText, type ExtensionRuntimeLog } from './runtime'
import type { ExtensionExecutorWorkerEvent, ExtensionExecutorWorkerRequest } from './executor-worker'

const MAX_WORKER_OUTPUT = 1_000_000
const MAX_WORKER_LINE = 256_000
const DEFAULT_TERMINATION_GRACE_MS = 250

export interface ExtensionExecutorProcessOptions {
  workerPath: string
  nodeArguments?: readonly string[]
  cwd?: string
  environment?: NodeJS.ProcessEnv
  validationDeadlineMs?: number
  preparationDeadlineMs?: number
  executionDeadlineMs?: number
  terminationGraceMs?: number
}

export interface ExtensionExecutorOperationOptions {
  signal: AbortSignal
  onProgress?: (progress: ExtensionProgress) => void
  onLog?: (entry: ExtensionRuntimeLog) => void
}

interface ExecutorSelection {
  entry: ExtensionCatalogEntry
  sourceConfiguration: ExtensionSourceConfiguration
  executorId: string
}

export class ExtensionExecutorProcessError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ExtensionExecutorProcessError'
  }
}

export class NodeExtensionExecutorProcess {
  constructor(private readonly options: ExtensionExecutorProcessOptions) {}

  validate(
    selection: ExecutorSelection,
    input: ExtensionSkillValidationInput,
    options: ExtensionExecutorOperationOptions,
  ): Promise<ExtensionSkillConfigurationValidation> {
    return this.run('validate', selection, input, undefined, options) as Promise<ExtensionSkillConfigurationValidation>
  }

  prepare(
    selection: ExecutorSelection,
    input: ExtensionSkillPreparationInput,
    options: ExtensionExecutorOperationOptions,
  ): Promise<ExtensionSkillPreparedPlan> {
    return this.run('prepare', selection, input, undefined, options) as Promise<ExtensionSkillPreparedPlan>
  }

  execute(
    selection: ExecutorSelection,
    input: ExtensionSkillExecutionInput,
    secrets: Readonly<Record<string, string | undefined>>,
    options: ExtensionExecutorOperationOptions,
  ): Promise<ExtensionSkillResult> {
    return this.run('execute', selection, input, secrets, options) as Promise<ExtensionSkillResult>
  }

  private async run(
    operation: 'validate' | 'prepare' | 'execute',
    selection: ExecutorSelection,
    input: ExtensionSkillValidationInput | ExtensionSkillPreparationInput | ExtensionSkillExecutionInput,
    secrets: Readonly<Record<string, string | undefined>> | undefined,
    execution: ExtensionExecutorOperationOptions,
  ): Promise<ExtensionSkillConfigurationValidation | ExtensionSkillPreparedPlan | ExtensionSkillResult> {
    execution.signal.throwIfAborted()
    const requestId = randomUUID()
    const scopedSecrets = operation === 'execute'
      ? scopeExecutorSecrets(selection.entry, secrets ?? {})
      : undefined
    const request = {
      requestId,
      operation,
      ...selection,
      input,
      ...(operation === 'execute' ? { secrets: scopedSecrets ?? {} } : {}),
    } as ExtensionExecutorWorkerRequest
    const secretValues = operation === 'execute'
      ? Object.values(scopedSecrets ?? {}).filter((value): value is string => Boolean(value))
      : []
    const child = spawn(process.execPath, [...(this.options.nodeArguments ?? []), this.options.workerPath], {
      cwd: this.options.cwd,
      env: this.options.environment ?? credentialFreeExecutorEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    let stdout = ''
    let stderr = ''
    let totalOutput = 0
    let result: ExtensionSkillConfigurationValidation | ExtensionSkillPreparedPlan | ExtensionSkillResult | undefined
    let protocolError: ExtensionExecutorProcessError | undefined
    let terminationReason: 'cancelled' | 'deadline' | 'protocol' | undefined
    let closed = false
    let killTimer: ReturnType<typeof setTimeout> | undefined
    const terminate = (reason: typeof terminationReason) => {
      if (closed || terminationReason) return
      terminationReason = reason
      child.kill('SIGTERM')
      killTimer = setTimeout(() => { if (!closed) child.kill('SIGKILL') }, this.options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS)
      killTimer.unref()
    }
    const abort = () => terminate('cancelled')
    execution.signal.addEventListener('abort', abort, { once: true })
    if (execution.signal.aborted) abort()
    const deadline = setTimeout(
      () => terminate('deadline'),
      operation === 'validate'
        ? this.options.validationDeadlineMs ?? 10_000
        : operation === 'prepare'
          ? this.options.preparationDeadlineMs ?? 15_000
          : this.options.executionDeadlineMs ?? 120_000,
    )
    deadline.unref()
    const acceptLine = (line: string): void => {
      if (!line.trim() || terminationReason || protocolError) return
      if (line.length > MAX_WORKER_LINE) {
        protocolError = new ExtensionExecutorProcessError('executor_protocol_exceeded', 'Extension executor worker emitted an oversized protocol message.')
        terminate('protocol')
        return
      }
      let event: ExtensionExecutorWorkerEvent
      try {
        event = JSON.parse(line) as ExtensionExecutorWorkerEvent
      } catch {
        protocolError = new ExtensionExecutorProcessError('invalid_executor_protocol', 'Extension executor worker emitted invalid JSON.')
        terminate('protocol')
        return
      }
      if (!event || typeof event !== 'object' || event.requestId !== requestId) {
        protocolError = new ExtensionExecutorProcessError('stale_executor_event', 'Extension executor worker emitted a stale or mismatched event.')
        terminate('protocol')
        return
      }
      if (event.type === 'log') {
        try {
          const value = sanitizeObservable(event.value, secretValues) as ExtensionLogEntry
          const parsed = extensionLogEntrySchema.parse({ level: value.level, message: value.message, ...(value.data === undefined ? {} : { data: value.data }) })
          if (!execution.signal.aborted) execution.onLog?.({ ...parsed, installationId: selection.entry.source.installationId, extensionId: selection.entry.manifest!.id })
        } catch (error) {
          protocolError = invalidObservableError(error, secretValues)
          terminate('protocol')
        }
        return
      }
      if (event.type === 'progress') {
        try {
          const parsed = extensionProgressSchema.parse(sanitizeObservable(event.value, secretValues))
          if (!execution.signal.aborted) execution.onProgress?.(parsed)
        } catch (error) {
          protocolError = invalidObservableError(error, secretValues)
          terminate('protocol')
        }
        return
      }
      if (event.type === 'error') {
        const code = typeof event.code === 'string' ? event.code.slice(0, 80) : 'executor_worker_failed'
        const message = sanitizeExtensionText(typeof event.message === 'string' ? event.message : 'Extension executor worker failed.', secretValues)
        protocolError = new ExtensionExecutorProcessError(code, message)
        return
      }
      if (event.type !== 'result' || event.operation !== operation || result !== undefined) {
        protocolError = new ExtensionExecutorProcessError('invalid_executor_protocol', 'Extension executor worker emitted an unexpected result.')
        terminate('protocol')
        return
      }
      try {
        if (operation === 'prepare') {
          result = extensionSkillPreparedPlanSchema.parse(event.value)
        } else if (operation === 'execute') {
          const value = event.value as ExtensionSkillResult
          const parsed = parseStructuredResult({
            version: 2,
            nodes: value.nodes,
            sources: value.sources ?? [],
            ...(value.reorder ? { reorder: value.reorder } : {}),
            ...(value.tags ? { tags: value.tags } : {}),
          }, { allowedReferenceIds: (input as ExtensionSkillExecutionInput).plan.admittedReferenceIds })
          if (parsed.version !== 2) throw new Error('Executor result must use generic structured text nodes.')
          result = {
            nodes: parsed.nodes,
            ...(value.sources ? { sources: parsed.sources } : {}),
            ...(parsed.reorder ? { reorder: parsed.reorder } : {}),
            ...(parsed.tags ? { tags: parsed.tags } : {}),
          }
        } else {
          result = parseValidationResult(event.value)
        }
      } catch (error) {
        protocolError = new ExtensionExecutorProcessError(
          operation === 'execute' ? 'invalid_executor_result' : 'invalid_executor_protocol',
          sanitizeExtensionText(error instanceof Error ? error.message : String(error), secretValues),
        )
        terminate('protocol')
      }
    }
    child.stdout.on('data', (chunk: string) => {
      if (closed) return
      totalOutput += chunk.length
      if (totalOutput > MAX_WORKER_OUTPUT) {
        protocolError = new ExtensionExecutorProcessError('executor_protocol_exceeded', 'Extension executor worker output exceeded its limit.')
        terminate('protocol')
        return
      }
      stdout += chunk
      let newline = stdout.indexOf('\n')
      while (newline >= 0) {
        const line = stdout.slice(0, newline)
        stdout = stdout.slice(newline + 1)
        acceptLine(line)
        newline = stdout.indexOf('\n')
      }
    })
    child.stderr.on('data', (chunk: string) => {
      totalOutput += chunk.length
      stderr = `${stderr}${chunk}`.slice(-8_000)
      if (totalOutput > MAX_WORKER_OUTPUT) terminate('protocol')
    })
    child.stdin.end(JSON.stringify(request))
    try {
      const exit = await new Promise<{ code: number | null }>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', (code) => resolve({ code }))
      })
      closed = true
      if (stdout.trim() && !terminationReason) acceptLine(stdout)
      if (execution.signal.aborted || terminationReason === 'cancelled') {
        throw new ExtensionExecutorProcessError('executor_cancelled', 'Extension executor operation was cancelled.')
      }
      if (terminationReason === 'deadline') {
        throw new ExtensionExecutorProcessError('executor_deadline_exceeded', 'Extension executor operation exceeded its deadline.')
      }
      if (protocolError) throw protocolError
      if (exit.code !== 0) {
        throw new ExtensionExecutorProcessError(
          'executor_worker_failed',
          sanitizeExtensionText(stderr.trim() || 'Extension executor worker exited unsuccessfully.', secretValues),
        )
      }
      if (result === undefined) throw new ExtensionExecutorProcessError('missing_executor_result', 'Extension executor worker exited without a complete result.')
      return result
    } finally {
      closed = true
      clearTimeout(deadline)
      if (killTimer) clearTimeout(killTimer)
      execution.signal.removeEventListener('abort', abort)
    }
  }
}

export function credentialFreeExecutorEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = ['HOME', 'PATH', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'SystemRoot', 'WINDIR']
  return Object.fromEntries(allowed.flatMap((key) => source[key] === undefined ? [] : [[key, source[key]]]))
}

function sanitizeObservable(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') return sanitizeExtensionText(value, secrets)
  if (Array.isArray(value)) return value.map((entry) => sanitizeObservable(entry, secrets))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
    sanitizeExtensionText(key, secrets),
    sanitizeObservable(entry, secrets),
  ]))
}

function parseValidationResult(value: unknown): ExtensionSkillConfigurationValidation {
  if (!value || typeof value !== 'object' || !('valid' in value) || typeof value.valid !== 'boolean') {
    throw new Error('Executor validation returned an invalid result.')
  }
  if (value.valid) return { valid: true }
  if (!('issues' in value) || !Array.isArray(value.issues) || value.issues.length < 1 || value.issues.length > 100) {
    throw new Error('Executor validation returned invalid issues.')
  }
  return {
    valid: false,
    issues: value.issues.map((issue) => {
      if (!issue || typeof issue !== 'object' || !('path' in issue) || !Array.isArray(issue.path)
        || issue.path.length > 32 || !issue.path.every((part: unknown) => typeof part === 'string' || Number.isInteger(part))
        || !('message' in issue) || typeof issue.message !== 'string' || issue.message.trim().length < 1 || issue.message.length > 500) {
        throw new Error('Executor validation returned an invalid issue.')
      }
      return { path: issue.path as Array<string | number>, message: issue.message }
    }),
  }
}

function scopeExecutorSecrets(
  entry: ExtensionCatalogEntry,
  values: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const declarations = entry.manifest?.contributes.settings ?? []
  const output: Record<string, string | undefined> = {}
  let characters = 0
  for (const declaration of declarations) {
    if (declaration.type !== 'secret') continue
    const value = values[declaration.key]
    if (value !== undefined) {
      characters += value.length
      if (value.length > 100_000 || characters > 500_000) {
        throw new ExtensionExecutorProcessError('executor_secrets_exceeded', 'Scoped extension secrets exceed the executor input limit.')
      }
    }
    output[declaration.key] = value
  }
  return output
}

function invalidObservableError(error: unknown, secrets: readonly string[]): ExtensionExecutorProcessError {
  return new ExtensionExecutorProcessError(
    'invalid_executor_observable',
    sanitizeExtensionText(error instanceof Error ? error.message : String(error), secrets),
  )
}
