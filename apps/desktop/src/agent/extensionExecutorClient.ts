import { resolveResource } from '@tauri-apps/api/path'
import { Command, type Child } from '@tauri-apps/plugin-shell'
import {
  extensionSkillAdmittedPlanSchema,
  localExtensionExecutorSnapshotSchema,
  type ExtensionCatalog,
  type ExtensionConfiguration,
  type ExtensionJsonObject,
  type ExtensionLogEntry,
  type ExtensionProgress,
  type ExtensionSkillAdmittedPlan,
  type ExtensionSkillContextSnapshot,
  type ExtensionSkillResult,
  type LocalExtensionExecutorSnapshot,
} from '@forage/agent-runtime'

const STDOUT_LINE_LIMIT = 2_000_000
const DEFAULT_TIMEOUT_MS = 20_000

export interface ExtensionExecutorAdmissionRequest {
  catalog: ExtensionCatalog
  localConfiguration: ExtensionConfiguration
  portableConfigurationRevision: number
  executor: { extensionId: string; executorId: string }
  runId: string
  configuration: ExtensionJsonObject
  context: ExtensionSkillContextSnapshot
  hostAdmittedReferenceIds: string[]
}

export interface ExtensionExecutorCallbacks {
  signal?: AbortSignal
  onProgress?: (progress: ExtensionProgress) => void
  onLog?: (entry: ExtensionLogEntry) => void
}

export interface PreparedExtensionExecutorAdmission {
  readonly admissionId: string
  readonly executorSnapshot: LocalExtensionExecutorSnapshot
  readonly portableConfigurationRevision: number
  readonly configuration: ExtensionJsonObject
  readonly context: ExtensionSkillContextSnapshot
  readonly plan: ExtensionSkillAdmittedPlan
  execute(secrets?: Readonly<Record<string, string | undefined>>, callbacks?: ExtensionExecutorCallbacks): Promise<ExtensionSkillResult>
  release(): Promise<void>
}

export interface ExtensionExecutorBridge {
  admit(input: ExtensionExecutorAdmissionRequest, callbacks?: ExtensionExecutorCallbacks): Promise<PreparedExtensionExecutorAdmission>
}

interface PendingRequest {
  operation: string
  resolve: (response: Record<string, unknown>) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  callbacks?: ExtensionExecutorCallbacks
  removeAbort?: () => void
}

export class ExtensionExecutorClient implements ExtensionExecutorBridge {
  private child: Child | null = null
  private pending = new Map<string, PendingRequest>()
  private stdoutBuffer = ''
  private sequence = 0
  private starting: Promise<void> | null = null

  async admit(input: ExtensionExecutorAdmissionRequest, callbacks: ExtensionExecutorCallbacks = {}): Promise<PreparedExtensionExecutorAdmission> {
    await this.start()
    const response = await this.request('admit', { input }, callbacks)
    const admissionId = typeof response.admissionId === 'string' ? response.admissionId : ''
    if (!admissionId) throw new Error('Extension executor returned an invalid admission identifier.')
    const executorSnapshot = localExtensionExecutorSnapshotSchema.parse(response.executorSnapshot)
    const plan = extensionSkillAdmittedPlanSchema.parse(response.plan)
    let released = false
    const release = async () => {
      if (released) return
      released = true
      await this.request('release', { admissionId })
    }
    return {
      admissionId,
      executorSnapshot,
      portableConfigurationRevision: Number(response.portableConfigurationRevision),
      configuration: structuredClone(input.configuration),
      context: structuredClone(input.context),
      plan,
      execute: async (secrets = {}, executionCallbacks = {}) => {
        if (released) throw new Error('The prepared extension admission has been released.')
        const executed = await this.request('execute', { admissionId, secrets }, executionCallbacks, 190_000)
        released = true
        if (!executed.result || typeof executed.result !== 'object') throw new Error('Extension executor returned an invalid result.')
        return executed.result as ExtensionSkillResult
      },
      release,
    }
  }

  async stop(): Promise<void> {
    const child = this.child
    this.child = null
    if (child) await child.kill().catch(() => undefined)
    this.rejectPending(new Error('Extension executor subprocess stopped.'))
  }

  private async start(): Promise<void> {
    if (this.child) return
    if (this.starting) return this.starting
    this.starting = (async () => {
      const entryPath = await resolveResource('resources/pi/sidecar/dist/executor.mjs')
      const command = Command.create('node-sidecar', [entryPath], { env: { PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' } })
      let ready: () => void = () => undefined
      let fail: (error: Error) => void = () => undefined
      const startup = new Promise<void>((resolve, reject) => { ready = resolve; fail = reject })
      const timeout = setTimeout(() => fail(new Error('Extension executor startup timed out.')), DEFAULT_TIMEOUT_MS)
      command.stdout.on('data', (data) => this.handleStdout(data, ready))
      command.stderr.on('data', () => undefined)
      command.on('error', (error) => this.fail(new Error(error)))
      command.on('close', ({ code, signal }) => this.fail(new Error(`Extension executor exited unexpectedly (code ${code}, signal ${signal}).`)))
      try {
        this.child = await command.spawn()
        await startup
      } catch (error) {
        await this.stop()
        throw new Error(`Could not start extension execution. ${message(error)}`)
      } finally {
        clearTimeout(timeout)
      }
    })().finally(() => { this.starting = null })
    return this.starting
  }

  private request(
    operation: string,
    value: Record<string, unknown>,
    callbacks?: ExtensionExecutorCallbacks,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    if (!this.child) return Promise.reject(new Error('Extension executor subprocess is not running.'))
    callbacks?.signal?.throwIfAborted()
    const requestId = `executor-request-${Date.now()}-${++this.sequence}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error(`Extension executor ${operation} timed out.`))
      }, timeoutMs)
      const pending: PendingRequest = { operation, resolve, reject, timer, callbacks }
      if (callbacks?.signal) {
        const abort = () => {
          this.finish(requestId)
          reject(new DOMException('Extension executor operation was cancelled.', 'AbortError'))
          void this.child?.write(`${JSON.stringify({ version: 1, kind: 'request', requestId: `${requestId}-cancel`, operation: 'cancel', targetRequestId: requestId })}\n`)
        }
        callbacks.signal.addEventListener('abort', abort, { once: true })
        pending.removeAbort = () => callbacks.signal?.removeEventListener('abort', abort)
      }
      this.pending.set(requestId, pending)
      void this.child!.write(`${JSON.stringify({ version: 1, kind: 'request', requestId, operation, ...value })}\n`).catch((error) => {
        this.finish(requestId)
        reject(new Error(`Could not write extension executor request. ${message(error)}`))
      })
    })
  }

  private handleStdout(data: string, ready: () => void): void {
    this.stdoutBuffer += data
    if (this.stdoutBuffer.length > STDOUT_LINE_LIMIT) return this.fail(new Error('Extension executor output exceeded the allowed message size.'))
    const lines = this.stdoutBuffer.split('\n')
    this.stdoutBuffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      let value: unknown
      try { value = JSON.parse(line) } catch { return this.fail(new Error('Extension executor emitted malformed protocol output.')) }
      const event = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
      if (event.kind === 'ready') { ready(); continue }
      const requestId = typeof event.requestId === 'string' ? event.requestId : ''
      const pending = this.pending.get(requestId)
      if (!pending) continue
      if (event.kind === 'event') {
        if (event.type === 'progress') pending.callbacks?.onProgress?.(event.value as ExtensionProgress)
        if (event.type === 'log') pending.callbacks?.onLog?.(event.value as ExtensionLogEntry)
        continue
      }
      if (event.kind !== 'response' || event.operation !== pending.operation) continue
      this.finish(requestId)
      if (event.ok === true) pending.resolve(event)
      else {
        const detail = Array.isArray(event.issues)
          ? event.issues.flatMap((issue) => {
            if (!issue || typeof issue !== 'object' || Array.isArray(issue)) return []
            const record = issue as Record<string, unknown>
            const path = Array.isArray(record.path) ? record.path.map(String).join('.') : ''
            return typeof record.message === 'string' ? [`${path ? `${path}: ` : ''}${record.message}`] : []
          }).slice(0, 5).join(' ')
          : ''
        const summary = typeof event.message === 'string' ? event.message : 'Extension executor failed.'
        pending.reject(new Error(detail ? `${summary} ${detail}` : summary))
      }
    }
  }

  private finish(requestId: string): void {
    const pending = this.pending.get(requestId)
    if (!pending) return
    clearTimeout(pending.timer)
    pending.removeAbort?.()
    this.pending.delete(requestId)
  }

  private fail(error: Error): void {
    this.child = null
    this.rejectPending(error)
  }

  private rejectPending(error: Error): void {
    for (const [requestId, pending] of this.pending) {
      this.finish(requestId)
      pending.reject(error)
    }
  }
}

let bridge: ExtensionExecutorBridge | null = null
export function extensionExecutorBridge(): ExtensionExecutorBridge {
  return (bridge ??= new ExtensionExecutorClient())
}

export function setExtensionExecutorBridgeForTests(value: ExtensionExecutorBridge | null): void {
  bridge = value
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
