import { invoke } from '@tauri-apps/api/core'
import { resolveResource } from '@tauri-apps/api/path'
import { Command, type Child } from '@tauri-apps/plugin-shell'
import {
  MCP_OAUTH_TIMEOUT_MS, mcpOAuthCredentialSchema, mcpOAuthLeaseSchema, mcpOAuthProgressSchema, mcpConnectionSchema,
  type McpOAuthCredential, type McpOAuthLease, type McpOAuthProgress, type McpConnection, type McpServerConfig,
} from '@forage/agent-runtime'

const messages = {
  sign_in_required: 'MCP: Sign in again to use this server.', unsupported: 'MCP: This server does not support this public-client sign-in setup.',
  denied: 'MCP: Sign-in was denied. Try again when you are ready.', expired: 'MCP: Sign-in expired. Start a new sign-in request.',
  failed: 'MCP: Sign-in failed. Check the server setup and try again.', transient: 'MCP: Authorization service is unavailable. Retry explicitly.',
  review_required: 'MCP: Review and save access in Settings before using this server.',
}
export class McpAuthorizationError extends Error {
  constructor(public readonly reason: keyof typeof messages) { super(messages[reason]) }
}
type WorkerResult = { credential: McpOAuthCredential; connection?: McpConnection }

async function worker(payload: unknown, signal: AbortSignal, progress?: (value: McpOAuthProgress) => Promise<void>): Promise<WorkerResult> {
  signal.throwIfAborted()
  const entry = await resolveResource('resources/pi/sidecar/dist/mcp-oauth.mjs')
  const command = Command.create('node-sidecar', [entry])
  let child: Child | undefined
  let buffer = ''
  let settled = false
  let queue = Promise.resolve()
  let resolve!: (value: WorkerResult) => void
  let reject!: (error: Error) => void
  const result = new Promise<WorkerResult>((res, rej) => { resolve = res; reject = rej })
  void result.catch(() => undefined)
  const fail = (error: Error) => { if (!settled) { settled = true; reject(error) } }
  const abort = () => fail(new McpAuthorizationError('failed'))
  const timer = setTimeout(() => fail(new McpAuthorizationError('expired')), MCP_OAUTH_TIMEOUT_MS)
  signal.addEventListener('abort', abort, { once: true })
  command.stdout.on('data', (chunk) => {
    if (settled) return
    buffer += chunk
    if (buffer.length > 500_000) { fail(new McpAuthorizationError('failed')); return }
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) queue = queue.then(async () => {
      if (settled || signal.aborted) return
      const value = JSON.parse(line) as Record<string, unknown>
      if (value.type === 'progress') { const { type: _type, ...body } = value; await progress?.(mcpOAuthProgressSchema.parse(body)); return }
      if (value.type !== 'result' || typeof value.ok !== 'boolean') throw new McpAuthorizationError('failed')
      if (!value.ok) { fail(new McpAuthorizationError(typeof value.reason === 'string' && Object.prototype.hasOwnProperty.call(messages, value.reason) ? value.reason as keyof typeof messages : 'failed')); return }
      const parsed = { credential: mcpOAuthCredentialSchema.parse(value.credential), ...(value.connection ? { connection: mcpConnectionSchema.parse(value.connection) } : {}) }
      settled = true
      resolve(parsed)
    }).catch(() => fail(new McpAuthorizationError('failed')))
  })
  command.on('error', () => fail(new McpAuthorizationError('failed')))
  command.on('close', () => { void queue.then(() => { if (!settled) fail(new McpAuthorizationError('failed')) }) })
  try {
    child = await command.spawn()
    signal.throwIfAborted()
    await child.write(`${JSON.stringify(payload)}\n`)
    return await result
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
    await child?.kill().catch(() => undefined)
  }
}

interface ActiveAuthorization { id: string; lease?: McpOAuthLease; controller: AbortController; url?: string }
let active: ActiveAuthorization | undefined
const tokenQueue = new Map<string, Promise<string>>()
let onRequired: (id: string, revision?: string) => Promise<void> = async () => undefined
let allowed: (id: string, revision?: string) => boolean = () => false

export function onMcpSignInRequired(handler: (id: string, revision?: string) => Promise<void>) { onRequired = handler }
export function onMcpAuthorizationAllowed(handler: (id: string, revision?: string) => boolean) { allowed = handler }
export function markMcpSignInRequired(id: string, revision?: string) { void onRequired(id, revision).catch(() => undefined) }

export async function cancelMcpAuthorization(): Promise<void> {
  const job = active
  active = undefined
  if (!job) return
  job.controller.abort()
  if (job.lease) await invoke('mcp_oauth_release', { id: job.id, lease: job.lease }).catch(() => undefined)
}
export async function openMcpAuthorizationBrowser(): Promise<void> {
  if (!active?.url || !active.lease) throw new McpAuthorizationError('failed')
  await invoke('mcp_oauth_open_browser', { id: active.id, lease: active.lease })
}
export async function copyMcpAuthorizationLink(): Promise<void> {
  if (!active?.url) throw new McpAuthorizationError('failed')
  await navigator.clipboard.writeText(active.url)
}

export async function authorizeLocalMcp(id: string, name: string, config: McpServerConfig, progress: (value: McpOAuthProgress | null) => void): Promise<McpConnection> {
  await cancelMcpAuthorization()
  if (!('url' in config) || config.authentication?.method !== 'oauth') throw new McpAuthorizationError('failed')
  const job: ActiveAuthorization = { id, controller: new AbortController() }
  active = job
  try {
    progress({ phase: 'checking' })
    const lease = mcpOAuthLeaseSchema.parse(await invoke('mcp_oauth_begin', { id, resource: config.url, interactive: true }))
    job.lease = lease
    job.controller.signal.throwIfAborted()
    const result = await worker({ action: 'authorize', id, name, config }, job.controller.signal, async (value) => {
      if (active !== job) return
      if (value.authorizationUrl) {
        job.url = value.authorizationUrl
        await invoke('mcp_oauth_set_url', { id, lease, authorizationUrl: value.authorizationUrl })
        if (active !== job) return
        progress(value)
        await openMcpAuthorizationBrowser().catch(() => undefined)
      } else progress(value)
    })
    job.controller.signal.throwIfAborted()
    if (active !== job || !result.connection || result.connection.id !== id || result.connection.environment !== 'local' || result.credential.resource !== config.url) throw new McpAuthorizationError('failed')
    await invoke('mcp_oauth_commit', { id, lease, credential: result.credential, configuration: JSON.stringify(config) })
    return result.connection
  } finally {
    if (active === job) { active = undefined; progress(null) }
    if (job.lease) await invoke('mcp_oauth_release', { id, lease: job.lease }).catch(() => undefined)
  }
}

export async function invalidateMcpAuthorization(id: string): Promise<void> {
  if (active?.id === id) await cancelMcpAuthorization()
  const removed = mcpOAuthCredentialSchema.safeParse(await invoke('mcp_oauth_invalidate', { id }))
  if (removed.success) void worker({ action: 'revoke', credential: removed.data }, AbortSignal.timeout(6_000)).catch(() => undefined)
}

if (typeof window !== 'undefined') window.addEventListener('pagehide', () => { void cancelMcpAuthorization() })

export function resolveMcpAccessToken(id: string, resource: string, signal: AbortSignal, revision?: string): Promise<string> {
  signal.throwIfAborted()
  if (!allowed(id, revision)) return Promise.reject(new McpAuthorizationError('review_required'))
  const key = `${id}\n${resource}\n${revision ?? ''}`
  const previous = tokenQueue.get(key)
  if (previous) return previous.then((token) => { signal.throwIfAborted(); if (!allowed(id, revision)) throw new McpAuthorizationError('review_required'); return token })
  const operation = resolveToken(id, resource, revision)
  tokenQueue.set(key, operation)
  void operation.finally(() => { if (tokenQueue.get(key) === operation) tokenQueue.delete(key) }).catch(() => undefined)
  return operation.then((token) => { signal.throwIfAborted(); if (!allowed(id, revision)) throw new McpAuthorizationError('review_required'); return token })
}

export function resolveMcpManagementAccessToken(id: string, resource: string, revision?: string): Promise<string> {
  return resolveToken(id, resource, revision)
}

async function resolveToken(id: string, resource: string, revision?: string): Promise<string> {
  let lease: McpOAuthLease | undefined
  try {
    const deadline = Date.now() + 30_000
    while (!lease) {
      try { lease = mcpOAuthLeaseSchema.parse(await invoke('mcp_oauth_begin', { id, resource, interactive: false })) }
      catch (error) {
        if (error !== 'OAuth operation is already pending.' || Date.now() >= deadline) throw error
        await new Promise<void>((resolve) => setTimeout(resolve, 100))
      }
    }
    const saved = mcpOAuthCredentialSchema.parse(await invoke('mcp_oauth_load', { id, lease }))
    if (saved.resource !== resource) throw new McpAuthorizationError('sign_in_required')
    if (saved.expiresAt > Date.now() + 30_000) return saved.tokens.access_token
    if (!saved.tokens.refresh_token) throw new McpAuthorizationError('sign_in_required')
    await invoke('mcp_oauth_refresh_start', { id, lease })
    const refreshed = await worker({ action: 'refresh', credential: saved }, AbortSignal.timeout(25_000))
    await invoke('mcp_oauth_commit', { id, lease, credential: refreshed.credential, configuration: null })
    return refreshed.credential.tokens.access_token
  } catch (error) {
    if (error instanceof McpAuthorizationError && error.reason === 'sign_in_required' || typeof error === 'string' && error.startsWith('MCP: Sign in')) {
      markMcpSignInRequired(id, revision)
      throw new McpAuthorizationError('sign_in_required')
    }
    throw new McpAuthorizationError('transient')
  } finally { if (lease) await invoke('mcp_oauth_release', { id, lease }).catch(() => undefined) }
}
