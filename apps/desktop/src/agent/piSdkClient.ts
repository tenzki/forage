import { appDataDir, resolveResource } from '@tauri-apps/api/path'
import { Command, type Child } from '@tauri-apps/plugin-shell'

const STDERR_LIMIT = 16_000
const STDOUT_LINE_LIMIT = 8_000_000

export type PiRpcEvent = Record<string, unknown> & { type: string }

export interface PiProcessOptions {
  provider: 'openai' | 'openai-codex'
  modelId: string
  apiKey: string
  /** ChatGPT workspace/account id used only by Codex subscription tools. */
  accountId: string
  /** Expiry of the short-lived ChatGPT OAuth access token. */
  oauthExpires?: number
}

export interface PiRuntimeStatus {
  available: boolean
  version?: string
  error?: string
}

async function probeRuntime(commandName: string, label: string): Promise<PiRuntimeStatus> {
  const command = Command.create(commandName, ['--version'])
  let stdout = ''
  let stderr = ''
  command.stdout.on('data', (data) => { stdout += data })
  command.stderr.on('data', (data) => { stderr += data })
  const closed = new Promise<{ code: number | null; error?: string }>((resolve) => {
    command.on('error', (error) => resolve({ code: null, error }))
    command.on('close', ({ code }) => resolve({ code }))
  })
  try {
    await command.spawn()
    const result = await closed
    const version = stdout.trim()
    return result.code === 0 && version
      ? { available: true, version }
      : { available: false, error: result.error || stderr.trim() || `${label} exited with code ${result.code}.` }
  } catch (error) {
    return { available: false, error: message(error) }
  }
}

export function probePiRuntime(): Promise<PiRuntimeStatus> {
  return probeRuntime('node-version', 'Pi SDK')
}

export function probeCodexRuntime(): Promise<PiRuntimeStatus> {
  return probeRuntime('codex-version', 'Codex')
}

export class PiRpcClient {
  private child: Child | null = null
  private command: Command<string> | null = null
  private listeners = new Set<(event: PiRpcEvent) => void>()
  private stderr = ''
  private stdoutBuffer = ''
  private stopping = false

  async start(options: PiProcessOptions): Promise<void> {
    if (this.child) throw new Error('Pi subprocess is already running.')
    this.stopping = false
    const agentDir = await appDataDir()

    const [indexPath] = await Promise.all([
      resolveResource('resources/pi/sidecar/index.ts'),
    ])

    // Invoke tsx's real entry point. Tauri dereferences the .bin/tsx symlink
    // when copying resources, which breaks its relative module imports.
    const tsxCli = await resolveResource('resources/pi/sidecar/node_modules/tsx/dist/cli.mjs')
    const args = [tsxCli, indexPath]
    const env = {
      PI_CODING_AGENT_DIR: `${agentDir.replace(/\/$/, '')}/pi-agent`,
      PI_SKIP_VERSION_CHECK: '1',
      PI_TELEMETRY: '0',
      AI_CHAT_PROVIDER: options.provider,
      AI_CHAT_API_KEY: options.apiKey,
      AI_CHAT_ACCOUNT_ID: options.accountId,
      AI_CHAT_MODEL_ID: options.modelId,
      ...(options.provider === 'openai-codex' && options.oauthExpires !== undefined
        ? { AI_CHAT_OAUTH_EXPIRES: String(options.oauthExpires) }
        : {}),
    }
    this.command = Command.create('node-sidecar', args, { env })
    this.attachProcessListeners(this.command)

    let unsubscribeStartup: () => void = () => undefined
    const startup = new Promise<void>((resolve, reject) => {
      unsubscribeStartup = this.onEvent((event) => {
        if (event.type === 'ready') {
          unsubscribeStartup()
          resolve()
        } else if (event.type === 'process_error') {
          unsubscribeStartup()
          reject(new Error(String(event.error || 'Pi SDK sidecar failed during startup.')))
        }
      })
    })
    try {
      this.child = await this.command.spawn()
    } catch (error) {
      unsubscribeStartup()
      throw new Error(`Could not start the Pi SDK sidecar. Install dependencies with 'cd sidecar && npm install'. ${message(error)}`)
    }
    try {
      await startup
    } finally {
      unsubscribeStartup()
    }
  }

  onEvent(listener: (event: PiRpcEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async prompt(message: string): Promise<void> {
    await this.write({ type: 'run', payload: message })
  }

  async abort(): Promise<void> {
    if (!this.child) return
    await this.write({ type: 'abort' })
  }

  waitForSettled(timeoutMs = 180_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        unsubscribe()
        reject(new Error(`Timed out waiting for Pi SDK. ${this.stderr}`))
      }, timeoutMs)
      const unsubscribe = this.onEvent((event) => {
        if (event.type === 'process_error') {
          window.clearTimeout(timer)
          unsubscribe()
          reject(new Error(String(event.error || 'Pi SDK sidecar failed.')))
        } else if (event.type === 'agent_settled') {
          window.clearTimeout(timer)
          unsubscribe()
          resolve()
        }
      })
    })
  }

  async stop(): Promise<void> {
    this.stopping = true
    const child = this.child
    this.child = null
    this.command = null
    if (child) {
      try {
        await child.kill()
      } catch (error) {
        console.warn('[pi-sdk] failed to stop subprocess:', error)
      }
    }
    this.listeners.clear()
  }

  getStderr(): string {
    return this.stderr
  }

  private attachProcessListeners(command: Command<string>): void {
    command.stdout.on('data', (data) => this.handleStdout(data))
    command.stderr.on('data', (data) => {
      this.stderr = `${this.stderr}${data}\n`.slice(-STDERR_LIMIT)
    })
    command.on('error', (error) => this.handleExit(new Error(error)))
    command.on('close', ({ code, signal }) => {
      if (this.stopping) return
      this.handleExit(new Error(`Pi SDK exited unexpectedly (code ${code}, signal ${signal}). ${this.stderr}`))
    })
  }

  private handleStdout(data: string): void {
    this.stdoutBuffer += data
    if (this.stdoutBuffer.length > STDOUT_LINE_LIMIT) {
      this.handleExit(new Error('Pi SDK output exceeded the allowed message size.'))
      return
    }
    const lines = this.stdoutBuffer.split('\n')
    this.stdoutBuffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        this.route(JSON.parse(line) as PiRpcEvent)
      } catch (error) {
        console.warn('[pi-sdk] ignored malformed output:', error)
      }
    }
  }

  private route(event: PiRpcEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  private write(command: Record<string, unknown>): Promise<void> {
    const child = this.child
    if (!child) return Promise.reject(new Error('Pi SDK subprocess is not running.'))
    return child.write(`${JSON.stringify(command)}\n`).catch((error) => {
      throw new Error(`Could not write to Pi SDK: ${message(error)}`)
    })
  }

  private handleExit(error: Error): void {
    this.child = null
    for (const listener of this.listeners) listener({ type: 'process_error', error: error.message })
  }

}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
