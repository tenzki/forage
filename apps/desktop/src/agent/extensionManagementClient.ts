import { resolveResource } from '@tauri-apps/api/path'
import { Command, type Child } from '@tauri-apps/plugin-shell'
import {
  extensionManagementResponseSchema,
  type ExtensionManagementRequest,
  type ExtensionManagementResponse,
} from '@forage/agent-runtime'

const STDERR_LIMIT = 16_000
const STDOUT_LINE_LIMIT = 1_000_000
const DEFAULT_TIMEOUT_MS = 15_000
const PACKAGE_TIMEOUT_MS = 120_000

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
export type ExtensionManagementCommand = DistributiveOmit<ExtensionManagementRequest, 'version' | 'kind' | 'requestId'>

interface PendingRequest {
  operation: ExtensionManagementRequest['operation']
  resolve: (response: ExtensionManagementResponse) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class ExtensionManagementClient {
  private child: Child | null = null
  private command: Command<string> | null = null
  private pending = new Map<string, PendingRequest>()
  private stdoutBuffer = ''
  private stderr = ''
  private stopping = false
  private sequence = 0
  private startupReject: ((error: Error) => void) | null = null

  async start(): Promise<void> {
    if (this.child) throw new Error('Extension management subprocess is already running.')
    this.stopping = false
    const entryPath = await resolveResource('resources/pi/sidecar/dist/management.mjs')
    this.command = Command.create('node-sidecar', [entryPath], { env: {
      PI_SKIP_VERSION_CHECK: '1',
      PI_TELEMETRY: '0',
    } })
    this.attach(this.command)
    let ready: () => void = () => undefined
    let fail: (error: Error) => void = () => undefined
    const startup = new Promise<void>((resolve, reject) => {
      ready = resolve
      fail = reject
      this.startupReject = reject
    })
    const startupTimeout = setTimeout(() => fail(new Error('Extension management startup timed out.')), DEFAULT_TIMEOUT_MS)
    const unsubscribe = this.onProtocolEvent((event) => {
      if (event.version === 1 && event.kind === 'ready') ready()
    })
    try {
      this.child = await this.command.spawn()
      await startup
    } catch (error) {
      await this.stop()
      throw new Error(`Could not start extension management. ${message(error)}`)
    } finally {
      clearTimeout(startupTimeout)
      unsubscribe()
      this.startupReject = null
    }
  }

  request(command: ExtensionManagementCommand, timeoutMs = ['preview_install', 'install', 'check_updates', 'update'].includes(command.operation) ? PACKAGE_TIMEOUT_MS : DEFAULT_TIMEOUT_MS): Promise<ExtensionManagementResponse> {
    if (!this.child) return Promise.reject(new Error('Extension management subprocess is not running.'))
    const requestId = `extension-request-${Date.now()}-${++this.sequence}`
    const request = { version: 1, kind: 'request', requestId, ...command } as ExtensionManagementRequest
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error(`Extension management ${command.operation} timed out.`))
      }, timeoutMs)
      this.pending.set(requestId, { operation: command.operation, resolve, reject, timer })
      void this.child!.write(`${JSON.stringify(request)}\n`).catch((error) => {
        clearTimeout(timer)
        this.pending.delete(requestId)
        reject(new Error(`Could not write extension management request. ${message(error)}`))
      })
    })
  }

  async stop(): Promise<void> {
    this.stopping = true
    const child = this.child
    this.child = null
    this.command = null
    if (child) await child.kill().catch(() => undefined)
    this.rejectPending(new Error('Extension management subprocess stopped.'))
  }

  getStderr(): string {
    return this.stderr
  }

  private readonly protocolListeners = new Set<(event: Record<string, unknown>) => void>()

  private onProtocolEvent(listener: (event: Record<string, unknown>) => void): () => void {
    this.protocolListeners.add(listener)
    return () => this.protocolListeners.delete(listener)
  }

  private attach(command: Command<string>): void {
    command.stdout.on('data', (data) => this.handleStdout(data))
    command.stderr.on('data', (data) => { this.stderr = `${this.stderr}${data}\n`.slice(-STDERR_LIMIT) })
    command.on('error', (error) => this.fail(new Error(error)))
    command.on('close', ({ code, signal }) => {
      if (!this.stopping) this.fail(new Error(`Extension management exited unexpectedly (code ${code}, signal ${signal}).`))
    })
  }

  private handleStdout(data: string): void {
    this.stdoutBuffer += data
    if (this.stdoutBuffer.length > STDOUT_LINE_LIMIT) {
      this.fail(new Error('Extension management output exceeded the allowed message size.'))
      return
    }
    const lines = this.stdoutBuffer.split('\n')
    this.stdoutBuffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      let raw: unknown
      try { raw = JSON.parse(line) } catch {
        this.fail(new Error('Extension management emitted malformed protocol output.'))
        return
      }
      const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
      for (const listener of this.protocolListeners) listener(record)
      if (record.kind === 'ready') continue
      const parsed = extensionManagementResponseSchema.safeParse(raw)
      if (!parsed.success) {
        this.fail(new Error('Extension management emitted an invalid protocol response.'))
        return
      }
      const pending = this.pending.get(parsed.data.requestId)
      if (!pending || pending.operation !== parsed.data.operation) continue
      clearTimeout(pending.timer)
      this.pending.delete(parsed.data.requestId)
      pending.resolve(parsed.data)
    }
  }

  private fail(error: Error): void {
    this.child = null
    this.startupReject?.(error)
    this.rejectPending(error)
  }

  private rejectPending(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    this.pending.clear()
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
