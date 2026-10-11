import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { mcpOAuthCredentialSchema } from '@forage/agent-runtime'

const root = fileURLToPath(new URL('.', import.meta.url))
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(cleanup.splice(0).map((close) => close())) })

function start(entry: string) {
  const child = spawn(process.execPath, ['--network-family-autoselection', ...(entry.endsWith('.mjs') ? [entry] : ['--import', 'tsx', entry])], {
    cwd: root, env: { ...process.env, AI_CHAT_API_KEY: 'model-secret-never-forward', OPENAI_API_KEY: 'model-secret-never-forward' }, stdio: ['pipe', 'pipe', 'pipe'],
  })
  cleanup.push(async () => { child.kill('SIGTERM') })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => { stdout += chunk })
  child.stderr.on('data', (chunk: string) => { stderr += chunk })
  const closed = new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('OAuth worker did not exit.')) }, 10_000)
    child.on('error', reject)
    child.on('close', (code) => { clearTimeout(timer); resolve({ stdout, stderr, code }) })
  })
  return { child, closed }
}

describe('isolated MCP OAuth worker packaging', () => {
  it.each([
    ['mcp-oauth.ts', false], ['dist/mcp-oauth.mjs', false], ['mcp-oauth.ts', true], ['dist/mcp-oauth.mjs', true],
  ] as const)('completes interactive %s consent and discovery over private IPC (registration=%s)', async (entry, registration) => {
    let origin = ''
    let tokenCalls = 0
    const server = createServer(async (request, response) => {
      const path = new URL(request.url!, origin).pathname
      response.setHeader('Content-Type', 'application/json')
      if (path.startsWith('/.well-known/oauth-protected-resource')) { response.end(JSON.stringify({ resource: `${origin}/mcp`, authorization_servers: [origin] })); return }
      if (path.startsWith('/.well-known/')) { response.end(JSON.stringify({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, ...(registration ? { registration_endpoint: `${origin}/register` } : {}), response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], authorization_response_iss_parameter_supported: true })); return }
      let body = ''
      for await (const chunk of request) body += chunk
      if (path === '/register') {
        response.end(JSON.stringify({ ...JSON.parse(body), client_id: 'forage-owned-public-client', client_secret: 'unused-registration-secret', client_secret_expires_at: 0, token_endpoint_auth_method: 'none' })); return
      }
      if (path === '/token') {
        expect(request.headers.authorization).toBeUndefined()
        expect(new URLSearchParams(body).has('client_secret')).toBe(false)
      }
      if (path === '/token') { tokenCalls += 1; response.end(JSON.stringify({ access_token: 'interactive-access', refresh_token: 'interactive-refresh', token_type: 'Bearer', expires_in: 3600 })); return }
      if (path === '/mcp' && request.method === 'POST') {
        expect(request.headers.authorization).toBe('Bearer interactive-access')
        const rpc = JSON.parse(body) as { method: string; id?: number }
        if (rpc.id === undefined) { response.writeHead(202).end(); return }
        const result = rpc.method === 'initialize' ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
          : rpc.method === 'tools/list' ? { tools: [{ name: 'lookup', description: 'Look up data', inputSchema: { type: 'object' } }] } : undefined
        response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, ...(result ? { result } : { error: { code: -32601, message: 'Method not found' } }) })); return
      }
      response.writeHead(405).end()
    })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }))
    origin = `http://localhost:${(server.address() as { port: number }).port}`
    const worker = start(fileURLToPath(new URL(entry, import.meta.url)))
    let buffer = ''
    const progress: Record<string, unknown>[] = []
    worker.child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      const lines = buffer.split('\n'); buffer = lines.pop() ?? ''
      for (const line of lines) {
        const message = JSON.parse(line) as Record<string, unknown>
        if (message.type !== 'progress') continue
        progress.push(message)
        if (typeof message.authorizationUrl === 'string') {
          const url = new URL(message.authorizationUrl)
          const callback = new URL(url.searchParams.get('redirect_uri')!)
          callback.searchParams.set('state', url.searchParams.get('state')!)
          callback.searchParams.set('iss', origin)
          callback.searchParams.set('code', 'fixture-code')
          void fetch(callback)
        }
      }
    })
    worker.child.stdin.write(`${JSON.stringify({ action: 'authorize', id: 'fixture', name: 'Fixture', config: { url: `${origin}/mcp`, headers: {}, authentication: { method: 'oauth', ...(!registration ? { clientId: 'forage-owned-public-client' } : {}) } } })}\n`)
    const result = await worker.closed
    const messages = result.stdout.trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(result.stderr).toBe('')
    expect(result.stdout).not.toContain('unused-registration-secret')
    expect(progress.map((message) => message.phase)).toEqual(['checking', 'waiting', 'exchanging', 'discovering'])
    expect(messages.at(-1)).toMatchObject({ type: 'result', ok: true, connection: { authentication: 'oauth', tools: [{ remoteName: 'lookup' }] } })
    expect(JSON.stringify(progress)).not.toMatch(/interactive-access|interactive-refresh|fixture-code|model-secret/)
    expect(result.stderr).toBe('')
    expect(tokenCalls).toBe(1)
  })
  it.each(['mcp-oauth.ts', 'dist/mcp-oauth.mjs'])('rejects an invalid %s request with no raw fields or credentials in errors', async (entry) => {
    const worker = start(fileURLToPath(new URL(entry, import.meta.url)))
    worker.child.stdin.write(`${JSON.stringify({ action: 'authorize', id: '../outside', name: 'private-name', config: { url: 'file:///private-path', headers: { Authorization: 'private-token' } } })}\n`)
    const result = await worker.closed
    expect(JSON.parse(result.stdout)).toEqual({ type: 'result', ok: false, reason: 'failed' })
    expect(`${result.stdout}${result.stderr}`).not.toMatch(/private-|model-secret/)
  })
  it.each(['mcp-oauth.ts', 'dist/mcp-oauth.mjs'])('refreshes via %s without a model, browser, or replay', async (entry) => {
    let calls = 0
    const server = createServer(async (request, response) => {
      calls += 1
      let body = ''
      for await (const chunk of request) body += chunk
      const parameters = new URLSearchParams(body)
      expect(parameters.get('grant_type')).toBe('refresh_token')
      expect(parameters.get('refresh_token')).toBe('refresh-private')
      expect(body).not.toContain('model-secret')
      response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', token_type: 'Bearer', expires_in: 3600 }))
    })
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }))
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const credential = { resource: `${origin}/mcp`, issuer: origin, clientInformation: { client_id: 'forage' },
      discovery: { authorizationServerUrl: origin, authorizationServerMetadata: { issuer: origin, token_endpoint: `${origin}/token` } },
      tokens: { access_token: 'expired-access', refresh_token: 'refresh-private', token_type: 'Bearer' }, expiresAt: 0 }
    const worker = start(fileURLToPath(new URL(entry, import.meta.url)))
    worker.child.stdin.write(`${JSON.stringify({ action: 'refresh', credential })}\n`)
    const result = await worker.closed
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).not.toContain('model-secret')
    const message = JSON.parse(result.stdout) as { ok: boolean; credential: unknown }
    expect(message.ok).toBe(true)
    expect(mcpOAuthCredentialSchema.parse(message.credential).tokens.refresh_token).toBe('rotated-refresh')
    expect(calls).toBe(1)
  })
})
