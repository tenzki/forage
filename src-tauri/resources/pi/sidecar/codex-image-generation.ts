import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_RPC_LINE_CHARS = 7_100_000
const STDERR_LIMIT = 16_000
const REQUEST_TIMEOUT_MS = 30_000
const GENERATION_TIMEOUT_MS = 180_000

interface RpcMessage {
  id?: number
  method?: string
  params?: unknown
  result?: unknown
  error?: { message?: unknown }
}

interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface ImageGenerationItem {
  type: 'imageGeneration'
  status: string
  result: string
  revisedPrompt?: string | null
  failure?: { type?: string; resetsAt?: number | null } | null
}

export interface CodexImageRequest {
  prompt: string
  size: string
  quality: string
  accessToken: string
  accountId: string
  signal?: AbortSignal
}

export interface CodexImageResult {
  base64: string
  revisedPrompt: string | null
}

class CodexRpcClient {
  private nextId = 0
  private buffer = ''
  private stderr = ''
  private pending = new Map<number, PendingRequest>()
  private listeners = new Set<(message: RpcMessage) => void>()

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on('data', (chunk) => this.read(String(chunk)))
    child.stderr.on('data', (chunk) => {
      this.stderr = `${this.stderr}${String(chunk)}`.slice(-STDERR_LIMIT)
    })
    child.on('error', (error) => this.failAll(error))
    child.on('close', (code) => this.failAll(new Error(`Codex app-server exited with code ${code}. ${this.stderr}`)))
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Codex app-server did not acknowledge ${method}. ${this.stderr}`))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      this.write({ id, method, params })
    })
  }

  notify(method: string, params: unknown): void {
    this.write({ method, params })
  }

  subscribe(listener: (message: RpcMessage) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  diagnostics(): string {
    return this.stderr
  }

  private write(message: RpcMessage): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private read(chunk: string): void {
    this.buffer += chunk
    if (this.buffer.length > MAX_RPC_LINE_CHARS) {
      this.failAll(new Error('Codex image response exceeded the allowed size.'))
      this.child.kill()
      return
    }
    const lines = this.buffer.split('\n')
    this.buffer = lines.pop() ?? ''
    for (const line of lines) this.routeLine(line)
  }

  private routeLine(line: string): void {
    if (!line.trim()) return
    let message: RpcMessage
    try {
      message = JSON.parse(line) as RpcMessage
    } catch {
      this.failAll(new Error('Codex app-server returned malformed JSON.'))
      return
    }
    if (typeof message.id === 'number' && !message.method) this.resolveRequest(message)
    else if (typeof message.id === 'number' && message.method) this.rejectServerRequest(message)
    else for (const listener of this.listeners) listener(message)
  }

  private resolveRequest(message: RpcMessage): void {
    const request = this.pending.get(message.id!)
    if (!request) return
    this.pending.delete(message.id!)
    clearTimeout(request.timer)
    if (message.error) request.reject(new Error(String(message.error.message || 'Codex request failed.')))
    else request.resolve(message.result)
  }

  private rejectServerRequest(message: RpcMessage): void {
    this.write({
      id: message.id,
      error: { message: `AI Chat does not permit the Codex request ${message.method}.` },
    })
  }

  private failAll(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    this.pending.clear()
    for (const listener of this.listeners) {
      listener({ method: 'process/error', params: { message: error.message } })
    }
  }
}

function isolatedEnvironment(root: string): NodeJS.ProcessEnv {
  const allowed = [
    'PATH', 'LANG', 'LC_ALL', 'SSL_CERT_FILE', 'CODEX_CA_CERTIFICATE',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  ]
  const env = Object.fromEntries(allowed.flatMap((name) => {
    const value = process.env[name]
    return value ? [[name, value]] : []
  }))
  return {
    ...env,
    HOME: join(root, 'home'),
    TMPDIR: join(root, 'tmp'),
    CODEX_HOME: join(root, 'codex-home'),
  }
}

function codexArguments(): string[] {
  const disabled = [
    'shell_tool', 'unified_exec', 'shell_snapshot', 'apps', 'multi_agent',
    'hooks', 'memories', 'remote_plugin', 'view_image',
  ].flatMap((feature) => ['--disable', feature])
  return [
    'app-server', '--listen', 'stdio://', '--strict-config',
    '--enable', 'image_generation', ...disabled,
    '-c', 'web_search="disabled"',
    '-c', 'history.persistence="none"',
    '-c', 'check_for_update_on_startup=false',
    '-c', 'feedback.enabled=false',
    '-c', 'shell_environment_policy.inherit="none"',
  ]
}

async function createIsolatedRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ai-chat-codex-image-'))
  await Promise.all([
    mkdir(join(root, 'home'), { recursive: true }),
    mkdir(join(root, 'tmp'), { recursive: true }),
    mkdir(join(root, 'codex-home'), { recursive: true }),
    mkdir(join(root, 'workspace'), { recursive: true }),
  ])
  return root
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

function threadId(result: unknown): string {
  const value = asRecord(asRecord(result)?.thread)?.id
  if (typeof value !== 'string' || !value) throw new Error('Codex did not return an image thread id.')
  return value
}

function imagePrompt(request: CodexImageRequest): string {
  return [
    '$imagegen Generate exactly one image for this prompt:',
    request.prompt,
    `Requested canvas: ${request.size}. Requested quality: ${request.quality}.`,
    'Do not call any tool except the built-in image generation tool.',
  ].join('\n\n')
}

function imageFailure(item: ImageGenerationItem): Error {
  if (item.failure?.type === 'usageLimitExceeded') {
    const reset = item.failure.resetsAt
      ? ` The image limit resets at ${new Date(item.failure.resetsAt * 1000).toLocaleString()}.`
      : ''
    return new Error(`Codex image-generation usage limit reached.${reset}`)
  }
  return new Error(`Codex image generation failed with status ${item.status}.`)
}

function waitForImage(client: CodexRpcClient, signal?: AbortSignal): Promise<ImageGenerationItem> {
  return new Promise((resolve, reject) => {
    const finish = (action: () => void) => {
      unsubscribe()
      signal?.removeEventListener('abort', abort)
      action()
    }
    const abort = () => finish(() => reject(new DOMException('Image generation cancelled.', 'AbortError')))
    const unsubscribe = client.subscribe((message) => {
      if (message.method === 'item/completed') {
        const item = asRecord(asRecord(message.params)?.item)
        if (item?.type === 'imageGeneration') finish(() => resolve(item as unknown as ImageGenerationItem))
      } else if (message.method === 'turn/completed') {
        const turn = asRecord(asRecord(message.params)?.turn)
        const error = asRecord(turn?.error)?.message
        finish(() => reject(new Error(typeof error === 'string' ? error : `Codex completed without an image. ${client.diagnostics()}`)))
      } else if (message.method === 'process/error') {
        const detail = asRecord(message.params)?.message
        finish(() => reject(new Error(typeof detail === 'string' ? detail : 'Codex app-server stopped.')))
      }
    })
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
  })
}

async function runImageTurn(client: CodexRpcClient, root: string, request: CodexImageRequest): Promise<ImageGenerationItem> {
  await client.request('initialize', {
    clientInfo: { name: 'ai_chat', title: 'AI Chat', version: '0.1.0' },
    capabilities: { experimentalApi: true, requestAttestation: false },
  })
  client.notify('initialized', {})
  await client.request('account/login/start', {
    type: 'chatgptAuthTokens',
    accessToken: request.accessToken,
    chatgptAccountId: request.accountId,
  })
  const started = await client.request('thread/start', {
    cwd: join(root, 'workspace'),
    approvalPolicy: 'never',
    sandbox: 'read-only',
    ephemeral: true,
    serviceName: 'ai_chat_image_generation',
    developerInstructions: 'Call the built-in image generation tool exactly once. Never call shell, file, web, app, connector, or multi-agent tools.',
  })
  const waiting = waitForImage(client, request.signal)
  await client.request('turn/start', {
    threadId: threadId(started),
    input: [{ type: 'text', text: imagePrompt(request) }],
    approvalPolicy: 'never',
    sandboxPolicy: { type: 'readOnly', networkAccess: false },
    effort: 'low',
  })
  return waiting
}

export function validCodexPng(base64: string): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 !== 0) return false
  const bytes = Buffer.from(base64, 'base64')
  return bytes.length > 0 && bytes.length <= MAX_IMAGE_BYTES
    && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve()
    }, 2_000)
    child.once('close', () => {
      clearTimeout(timer)
      resolve()
    })
    child.kill()
  })
}

export async function generateCodexSubscriptionImage(request: CodexImageRequest): Promise<CodexImageResult> {
  if (!request.accessToken.trim() || !request.accountId.trim()) {
    throw new Error('ChatGPT subscription credentials are missing. Reconnect ChatGPT in Settings.')
  }
  const root = await createIsolatedRoot()
  const child = spawn('codex', codexArguments(), {
    cwd: join(root, 'workspace'),
    env: isolatedEnvironment(root),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const client = new CodexRpcClient(child)
  const timeout = AbortSignal.timeout(GENERATION_TIMEOUT_MS)
  const combinedSignal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout
  try {
    const item = await runImageTurn(client, root, { ...request, signal: combinedSignal })
    if (item.status !== 'completed') throw imageFailure(item)
    if (!validCodexPng(item.result)) throw new Error('Codex returned an invalid or oversized PNG image.')
    return { base64: item.result, revisedPrompt: item.revisedPrompt ?? null }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
      throw new Error('Codex CLI is unavailable. Install Codex 0.148.0 or later and restart the app.')
    }
    throw error
  } finally {
    await stopChild(child)
    try {
      await rm(root, { recursive: true, force: true })
    } catch (error) {
      console.error('[codex-image] failed to remove temporary credentials:', error)
    }
  }
}
