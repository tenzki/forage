import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type McpOAuthCredential } from '@forage/agent-runtime'

const invokeMock = vi.hoisted(() => vi.fn())
const createCommand = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
vi.mock('@tauri-apps/api/path', () => ({ resolveResource: async (path: string) => `/resources/${path}` }))
vi.mock('@tauri-apps/plugin-shell', () => ({ Command: { create: createCommand } }))
import { authorizeLocalMcp, cancelMcpAuthorization, copyMcpAuthorizationLink, onMcpSignInRequired, onMcpAuthorizationAllowed, openMcpAuthorizationBrowser, resolveMcpAccessToken } from './mcpOAuthClient'

const credential: McpOAuthCredential = { resource: 'https://example.com/mcp', issuer: 'https://auth.example.com',
  clientInformation: { client_id: 'forage' }, discovery: { authorizationServerUrl: 'https://auth.example.com' },
  tokens: { access_token: 'old-access', refresh_token: 'private-refresh', token_type: 'Bearer' }, expiresAt: 0 }
let saved: McpOAuthCredential
let workerReply: Record<string, unknown>
let stdout: (line: string) => void
let childKill: ReturnType<typeof vi.fn>
let writes: string[]
let committed: boolean
const lease = { generation: 1, version: 1, leaseId: 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa' }
beforeEach(() => {
  saved = structuredClone(credential)
  onMcpAuthorizationAllowed(() => true)
  committed = false
  writes = []
  childKill = vi.fn(async () => undefined)
  workerReply = { type: 'result', ok: true, credential: { ...saved, expiresAt: Date.now() + 3_600_000, tokens: { ...saved.tokens, access_token: 'fresh-access' } } }
  invokeMock.mockReset()
  invokeMock.mockImplementation(async (command: string, args: Record<string, unknown>) => {
    if (command === 'mcp_oauth_begin') return lease
    if (command === 'mcp_oauth_load') return saved
    if (command === 'mcp_oauth_commit') { saved = args.credential as McpOAuthCredential; committed = true }
  })
  createCommand.mockReset()
  createCommand.mockImplementation(() => ({ stdout: { on: (_event: string, callback: typeof stdout) => { stdout = callback } }, on: vi.fn(),
    spawn: async () => ({ kill: childKill, write: async (message: string) => { writes.push(message); setTimeout(() => stdout(`${JSON.stringify(workerReply)}\n`), 0) } }),
  }))
})
afterEach(async () => { await cancelMcpAuthorization(); onMcpSignInRequired(async () => undefined) })

describe('app-owned MCP OAuth broker', () => {
  it('denies old review revisions and unavailable grants before resolving credentials', async () => {
    onMcpAuthorizationAllowed((_id, revision) => revision === 'current-review')
    await expect(resolveMcpAccessToken('fixture', credential.resource, new AbortController().signal, 'old-review')).rejects.toMatchObject({ reason: 'review_required' })
    expect(invokeMock).not.toHaveBeenCalled()
  })
  it('cancels while a native lease is being acquired without starting or committing a late worker', async () => {
    let finish!: (value: unknown) => void
    invokeMock.mockImplementation(async (command: string) => command === 'mcp_oauth_begin' ? new Promise((resolve) => { finish = resolve }) : undefined)
    const result = authorizeLocalMcp('fixture', 'Fixture', { url: credential.resource, headers: {}, authentication: { method: 'oauth' } }, vi.fn())
    void result.catch(() => undefined)
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith('mcp_oauth_begin', expect.anything()))
    await cancelMcpAuthorization()
    finish(lease)
    await expect(result).rejects.toThrow()
    expect(createCommand).not.toHaveBeenCalled()
    expect(invokeMock).toHaveBeenCalledWith('mcp_oauth_release', { id: 'fixture', lease })
  })
  it('shares a single refresh among concurrent callers and persists rotation before releasing access', async () => {
    const signal = new AbortController().signal
    const first = resolveMcpAccessToken('fixture', credential.resource, signal)
    const second = resolveMcpAccessToken('fixture', credential.resource, signal)
    await expect(Promise.all([first, second])).resolves.toEqual(['fresh-access', 'fresh-access'])
    expect(createCommand).toHaveBeenCalledOnce()
    expect(committed).toBe(true)
    expect(invokeMock).toHaveBeenCalledWith('mcp_oauth_refresh_start', { id: 'fixture', lease })
    expect(writes[0]).toContain('private-refresh')
    expect(childKill).toHaveBeenCalledOnce()
  })
  it('reads an unexpired access token without starting a worker or browser', async () => {
    saved.expiresAt = Date.now() + 3_600_000
    await expect(resolveMcpAccessToken('fixture', credential.resource, new AbortController().signal)).resolves.toBe('old-access')
    expect(createCommand).not.toHaveBeenCalled()
    expect(invokeMock.mock.calls.some(([command]) => command === 'mcp_oauth_open_browser')).toBe(false)
  })
  it('fails closed when durable rotation cannot be saved', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'mcp_oauth_begin') return lease
      if (command === 'mcp_oauth_load') return saved
      if (command === 'mcp_oauth_commit') throw new Error('private database path')
    })
    await expect(resolveMcpAccessToken('fixture', credential.resource, new AbortController().signal)).rejects.toMatchObject({ reason: 'transient' })
    expect(childKill).toHaveBeenCalledOnce()
  })
  it('does not replay a failed refresh or erase saved credentials on an outage', async () => {
    workerReply = { type: 'result', ok: false, reason: 'transient', error: 'private-refresh' }
    await expect(resolveMcpAccessToken('fixture', credential.resource, new AbortController().signal)).rejects.toThrow('unavailable')
    expect(createCommand).toHaveBeenCalledOnce()
    expect(invokeMock.mock.calls.some(([command]) => command === 'mcp_oauth_invalidate')).toBe(false)
    expect(saved.tokens.refresh_token).toBe('private-refresh')
  })
  it('marks missing or revoked refresh as sign-in required without an automatic browser', async () => {
    const required = vi.fn(async () => undefined)
    onMcpSignInRequired(required)
    delete saved.tokens.refresh_token
    await expect(resolveMcpAccessToken('fixture', credential.resource, new AbortController().signal)).rejects.toMatchObject({ reason: 'sign_in_required' })
    expect(required).toHaveBeenCalledWith('fixture', undefined)
    expect(createCommand).not.toHaveBeenCalled()
    saved.tokens.refresh_token = 'private-refresh'
    workerReply = { type: 'result', ok: false, reason: 'sign_in_required' }
    await expect(resolveMcpAccessToken('fixture', credential.resource, new AbortController().signal)).rejects.toMatchObject({ reason: 'sign_in_required' })
    expect(required).toHaveBeenCalledTimes(2)
  })
  it('reuses one active recovery URL, cancels the worker, and ignores late results', async () => {
    createCommand.mockImplementation(() => ({ stdout: { on: (_event: string, callback: typeof stdout) => { stdout = callback } }, on: vi.fn(),
      spawn: async () => ({ kill: childKill, write: async (message: string) => { writes.push(message) } }),
    }))
    const progress = vi.fn()
    const result = authorizeLocalMcp('fixture', 'Fixture', { url: credential.resource, headers: {}, authentication: { method: 'oauth' } }, progress)
    void result.catch(() => undefined)
    await vi.waitFor(() => expect(writes).toHaveLength(1))
    const url = 'https://auth.example.com/authorize?state=opaque&code_challenge_method=S256'
    stdout(`${JSON.stringify({ type: 'progress', phase: 'waiting', authorizationUrl: url })}\n`)
    await vi.waitFor(() => expect(progress).toHaveBeenCalledWith({ phase: 'waiting', authorizationUrl: url }))
    await openMcpAuthorizationBrowser()
    const clipboard = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: clipboard } })
    await copyMcpAuthorizationLink()
    expect(clipboard).toHaveBeenCalledWith(url)
    expect(writes).toHaveLength(1)
    await cancelMcpAuthorization()
    stdout(`${JSON.stringify(workerReply)}\n`)
    await expect(result).rejects.toThrow('Sign-in failed')
    expect(committed).toBe(false)
    expect(childKill).toHaveBeenCalledOnce()
    await expect(openMcpAuthorizationBrowser()).rejects.toThrow()
  })
})
