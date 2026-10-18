import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { getDefaultAutoSelectFamily, setDefaultAutoSelectFamily } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { authorizeMcp, refreshMcpCredential, McpOAuthError } from '../src/oauth'
import { oauthDestination, oauthFetch, publicAddress } from '../src/oauthFetch'
import { connectMcp } from '../src/index'
import { mcpConnectionSchema, mcpServerConfigSchema, selectMcpSnapshot, type McpOAuthCredential } from '@forage/agent-runtime'
import { discoverOAuthServerInfo } from '@modelcontextprotocol/client'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(cleanup.splice(0).map((close) => close())) })
async function listen(server: Server, host = '127.0.0.1') {
  await new Promise<void>((resolve) => server.listen(0, host, resolve))
  cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }))
  return `http://${host}:${(server.address() as { port: number }).port}`
}

async function fixture(options: { unsupported?: boolean; issuerMismatch?: boolean; failure?: number; rotation?: boolean; invalidGrant?: boolean; metadataClient?: boolean; disconnect?: boolean; hang?: boolean; privateIssuer?: boolean; oidc?: boolean; registrationSecret?: 'none' | 'client_secret_post' | 'omitted' } = {}) {
  let origin = ''
  let redirect = ''
  let challenge = ''
  let tokenCalls = 0
  let mutationCalls = 0
  const requests: Array<{ path: string; authorization?: string }> = []
  const server = createServer(async (request, response) => {
    const path = new URL(request.url!, origin).pathname
    requests.push({ path, authorization: request.headers.authorization })
    response.setHeader('Content-Type', 'application/json')
    if (path.startsWith('/.well-known/oauth-protected-resource')) { response.end(JSON.stringify({ resource: `${origin}/mcp`, authorization_servers: [options.privateIssuer ? 'http://10.0.0.1' : origin], scopes_supported: ['read', 'write'] })); return }
    if (options.oidc && path.startsWith('/.well-known/oauth-authorization-server')) { response.writeHead(404).end('{}'); return }
    if (path.startsWith('/.well-known/')) { response.end(JSON.stringify({ issuer: options.issuerMismatch ? `${origin}/wrong` : origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`,
      ...(options.oidc ? { jwks_uri: `${origin}/jwks`, subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'] } : {}),
      ...(!options.unsupported ? { registration_endpoint: `${origin}/register` } : {}), client_id_metadata_document_supported: !!options.metadataClient,
      response_types_supported: ['code'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], grant_types_supported: ['authorization_code', 'refresh_token'], authorization_response_iss_parameter_supported: true })); return }
    let body = ''
    for await (const chunk of request) body += chunk
    if (path === '/register') {
      const value = JSON.parse(body) as { redirect_uris: string[] }
      redirect = value.redirect_uris[0]!
      response.end(JSON.stringify({ client_id: 'forage-fixture', ...value, ...(options.registrationSecret ? {
        client_secret: 'unused-registration-secret', client_secret_expires_at: 0,
        token_endpoint_auth_method: options.registrationSecret === 'omitted' ? undefined : options.registrationSecret,
      } : {}) })); return
    }
    if (path === '/token') {
      tokenCalls += 1
      const params = new URLSearchParams(body)
      expect(request.headers.authorization).toBeUndefined()
      expect(params.has('client_secret')).toBe(false)
      if (options.invalidGrant) { response.writeHead(400).end(JSON.stringify({ error: 'invalid_grant', error_description: 'never-display-refresh-secret' })); return }
      if (params.get('grant_type') === 'authorization_code') {
        const actual = createHash('sha256').update(params.get('code_verifier')!).digest('base64url')
        if (params.get('redirect_uri') !== redirect || actual !== challenge || params.get('code') !== 'one-shot-code') { response.writeHead(400).end(JSON.stringify({ error: 'invalid_grant' })); return }
      }
      response.end(JSON.stringify({ access_token: 'access-secret', token_type: 'Bearer', expires_in: 3600, ...(options.rotation ? { refresh_token: 'rotated-secret' } : params.get('grant_type') === 'authorization_code' ? { refresh_token: 'refresh-secret' } : {}) })); return
    }
    if (path === '/mcp') {
      if (request.method !== 'POST') { response.writeHead(405).end(); return }
      const rpc = JSON.parse(body) as { id?: number; method: string }
      if (rpc.method === 'tools/call') { mutationCalls += 1; if (options.disconnect) { request.socket.destroy(); return } if (options.hang) return; if (options.failure) { response.writeHead(options.failure).end('{}'); return } }
      if (rpc.id === undefined) { response.writeHead(202).end(); return }
      const result = rpc.method === 'initialize' ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
        : rpc.method === 'tools/list' ? { tools: [{ name: 'mutate', description: 'Change data', inputSchema: { type: 'object' } }] }
          : { content: [{ type: 'text', text: 'access-secret' }] }
      response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result })); return
    }
    response.writeHead(404).end('{}')
  })
  origin = await listen(server)
  return { origin, requests, tokenCalls: () => tokenCalls, mutationCalls: () => mutationCalls,
    bindChallenge: (url: URL) => { challenge = url.searchParams.get('code_challenge')!; redirect ||= url.searchParams.get('redirect_uri')!; return redirect },
  }
}

async function signIn(server: Awaited<ReturnType<typeof fixture>>, callback: (url: URL) => Promise<void> = async (url) => { await fetch(url) }, registration: { method: 'oauth'; clientId?: string; clientMetadataUrl?: string } = { method: 'oauth' }) {
  const progress: unknown[] = []
  const result = await authorizeMcp({ id: 'fixture', name: 'Fixture' }, { url: `${server.origin}/mcp`, headers: {}, authentication: registration }, new AbortController().signal, (value) => {
    progress.push(value)
    if (value.authorizationUrl) {
      const authorization = new URL(value.authorizationUrl)
      const redirect = server.bindChallenge(authorization)
      const url = new URL(redirect)
      url.searchParams.set('state', authorization.searchParams.get('state')!)
      url.searchParams.set('code', 'one-shot-code')
      url.searchParams.set('iss', server.origin)
      void callback(url)
    }
  })
  return { ...result, progress }
}

describe('local MCP OAuth', () => {
  it('keeps legacy configuration and sanitized status backward-compatible and rejects conflicting credentials', () => {
    expect(mcpServerConfigSchema.parse({ url: 'https://example.com/mcp', headers: { Authorization: 'Bearer legacy' } })).not.toHaveProperty('authentication')
    expect(mcpServerConfigSchema.safeParse({ command: 'node', authentication: { method: 'oauth' } }).success).toBe(false)
    for (const method of ['oauth', 'none']) expect(mcpServerConfigSchema.safeParse({ url: 'https://example.com/mcp', headers: { authorization: 'secret' }, authentication: { method } }).success).toBe(false)
    expect(mcpServerConfigSchema.safeParse({ url: 'https://example.com/mcp', authentication: { method: 'oauth', clientId: 'one', clientMetadataUrl: 'https://example.com/client.json' } }).success).toBe(false)
    const connection = { id: 'fixture', name: 'Fixture', environment: 'local', enabled: true, tools: [], authentication: 'oauth', authorizationStatus: 'sign_in_required' }
    expect(selectMcpSnapshot([mcpConnectionSchema.parse(connection)], [])).toEqual([])
    expect(mcpConnectionSchema.safeParse({ ...connection, environment: 'server' }).success).toBe(false)
    expect(mcpConnectionSchema.safeParse({ ...connection, access_token: 'secret' }).success).toBe(false)
  })
  it('completes discovery, public registration, exact callback and S256 exchange without granting access', async () => {
    const server = await fixture()
    const result = await signIn(server)
    expect(result.connection).toMatchObject({ authentication: 'oauth', authorizationStatus: 'connected', tools: [{ remoteName: 'mutate' }] })
    expect(JSON.stringify(result.connection)).not.toContain('secret')
    expect(result.credential.tokens.refresh_token).toBe('refresh-secret')
    expect(server.tokenCalls()).toBe(1)
    expect(server.requests.filter(({ path }) => path !== '/mcp').every(({ authorization }) => authorization === undefined)).toBe(true)
    expect(result.progress).toMatchObject([{ phase: 'checking' }, { phase: 'waiting' }, { phase: 'exchanging' }, { phase: 'discovering' }])
  })
  it('discards unused registration secrets when the server explicitly selects public-client authentication', async () => {
    const server = await fixture({ registrationSecret: 'none' })
    const result = await signIn(server)
    expect(result.connection.authorizationStatus).toBe('connected')
    expect(result.credential.clientInformation).toMatchObject({ client_id: 'forage-fixture', token_endpoint_auth_method: 'none' })
    expect(result.credential.clientInformation).not.toHaveProperty('client_secret')
    expect(result.credential.clientInformation).not.toHaveProperty('client_secret_expires_at')
    expect(JSON.stringify(result)).not.toContain('unused-registration-secret')
    await refreshMcpCredential(result.credential, new AbortController().signal)
    expect(server.tokenCalls()).toBe(2)
  })
  it.each(['client_secret_post', 'omitted'] as const)('rejects registration secrets without explicit public-client authentication (%s)', async (registrationSecret) => {
    const server = await fixture({ registrationSecret })
    await expect(signIn(server)).rejects.toMatchObject({ reason: 'unsupported' })
    expect(server.tokenCalls()).toBe(0)
  })
  it('rejects the wrong state and path without consuming the legitimate callback', async () => {
    const server = await fixture()
    const result = await signIn(server, async (url) => {
      const wrong = new URL(url); wrong.searchParams.set('state', 'wrong')
      expect((await fetch(wrong)).status).toBe(400)
      wrong.pathname = '/wrong'
      expect((await fetch(wrong)).status).toBe(400)
      await fetch(url)
    })
    expect(result.credential.tokens.access_token).toBe('access-secret')
    expect(server.tokenCalls()).toBe(1)
  })
  it.each(['public-id', 'metadata-url'])('uses an explicit %s without registering a borrowed client', async (method) => {
    const server = await fixture({ unsupported: true, metadataClient: true })
    const result = await signIn(server, undefined, method === 'public-id' ? { method: 'oauth', clientId: 'forage-owned-client' } : { method: 'oauth', clientMetadataUrl: 'https://forage.example/client.json' })
    expect(result.credential.clientInformation.client_id).toBe(method === 'public-id' ? 'forage-owned-client' : 'https://forage.example/client.json')
    expect(server.requests.some(({ path }) => path === '/register')).toBe(false)
  })
  it('redeems one code only once when the callback is replayed', async () => {
    const server = await fixture()
    await signIn(server, async (url) => {
      const responses = await Promise.all([fetch(url), fetch(url)])
      expect(responses.map((response) => response.status).sort()).toEqual([200, 400])
    })
    expect(server.tokenCalls()).toBe(1)
  })
  it.each(['missing', 'wrong', 'denied'])('rejects %s callback issuer/consent without exchanging a code', async (reason) => {
    const server = await fixture()
    await expect(signIn(server, async (url) => {
      if (reason === 'missing') url.searchParams.delete('iss')
      else if (reason === 'wrong') url.searchParams.set('iss', `${server.origin}/wrong`)
      else url.searchParams.set('error', 'access_denied')
      await fetch(url)
    })).rejects.toThrow(/MCP: Sign-in/)
    expect(server.tokenCalls()).toBe(0)
  })
  it('reports unsupported registration and malformed issuer without opening consent', async () => {
    for (const options of [{ unsupported: true }, { issuerMismatch: true }]) {
      const server = await fixture(options)
      await expect(signIn(server)).rejects.toBeInstanceOf(McpOAuthError)
      expect(server.tokenCalls()).toBe(0)
    }
  })
  it('supports SDK OIDC discovery fallback without weakening issuer validation', async () => {
    const server = await fixture({ oidc: true })
    const discovered = await discoverOAuthServerInfo(`${server.origin}/mcp`, { fetchFn: oauthFetch(`${server.origin}/mcp`, new AbortController().signal) })
    expect(discovered.authorizationServerMetadata?.issuer).toBe(server.origin)
    await signIn(server)
    expect(server.requests.some(({ path }) => path.includes('openid-configuration'))).toBe(true)
  })
  it('rejects a private authorization-server injection before consent or any token exchange', async () => {
    const server = await fixture({ privateIssuer: true })
    await expect(signIn(server)).rejects.toBeInstanceOf(McpOAuthError)
    expect(server.tokenCalls()).toBe(0)
    expect(server.requests.some(({ path }) => path.includes('oauth-authorization-server'))).toBe(false)
  })
  it('cancels a pending callback and closes its loopback listener', async () => {
    const server = await fixture()
    const controller = new AbortController()
    let callback = ''
    const result = authorizeMcp({ id: 'fixture', name: 'Fixture' }, { url: `${server.origin}/mcp`, headers: {}, authentication: { method: 'oauth' } }, controller.signal, (value) => {
      if (value.authorizationUrl) { callback = new URL(value.authorizationUrl).searchParams.get('redirect_uri')!; controller.abort() }
    })
    await expect(result).rejects.toThrow('MCP: Sign-in')
    await expect(fetch(callback)).rejects.toThrow()
    expect(server.tokenCalls()).toBe(0)
  })
  it('bounds an unanswered interactive request and closes its listener on expiry', async () => {
    const server = await fixture()
    let callback = ''
    const result = authorizeMcp({ id: 'fixture', name: 'Fixture' }, { url: `${server.origin}/mcp`, headers: {}, authentication: { method: 'oauth' } }, new AbortController().signal,
      (value) => { if (value.authorizationUrl) callback = new URL(value.authorizationUrl).searchParams.get('redirect_uri')! }, 150)
    await expect(result).rejects.toMatchObject({ reason: 'expired' })
    if (callback) await expect(fetch(callback)).rejects.toThrow()
    expect(server.tokenCalls()).toBe(0)
  })
  it.each([false, true])('preserves omitted refresh tokens or commits a replacement (rotation=%s)', async (rotation) => {
    const server = await fixture({ rotation })
    const { credential } = await signIn(server)
    const refreshed = await refreshMcpCredential(credential, new AbortController().signal)
    expect(refreshed.tokens.refresh_token).toBe(rotation ? 'rotated-secret' : 'refresh-secret')
    expect(refreshed.expiresAt).toBeGreaterThan(Date.now())
    expect(server.tokenCalls()).toBe(2)
  })
  it('classifies missing/revoked refresh credentials without retry or secret-bearing errors', async () => {
    const server = await fixture({ invalidGrant: true })
    const saved: McpOAuthCredential = { resource: `${server.origin}/mcp`, issuer: server.origin, discovery: { authorizationServerUrl: server.origin, authorizationServerMetadata: { issuer: server.origin, token_endpoint: `${server.origin}/token` } },
      clientInformation: { client_id: 'fixture' }, tokens: { access_token: 'expired-secret', token_type: 'Bearer', refresh_token: 'refresh-secret' }, expiresAt: 0 }
    await expect(refreshMcpCredential(saved, new AbortController().signal)).rejects.toMatchObject({ reason: 'sign_in_required' })
    expect(server.tokenCalls()).toBe(1)
    delete saved.tokens.refresh_token
    await expect(refreshMcpCredential(saved, new AbortController().signal)).rejects.toMatchObject({ reason: 'sign_in_required' })
    expect(server.tokenCalls()).toBe(1)
  })
  it.each([401, 403, 500])('sends a mutation exactly once on HTTP %s with a token-only provider', async (failure) => {
    const server = await fixture({ failure })
    let tokenReads = 0
    let signInRequired = 0
    const session = await connectMcp({ id: 'fixture', name: 'Fixture', environment: 'local' }, { url: `${server.origin}/mcp`, headers: {}, authentication: { method: 'oauth' } }, new AbortController().signal,
      { accessToken: async () => { tokenReads += 1; return 'access-secret' }, unauthorized: () => { signInRequired += 1 } })
    cleanup.push(session.close)
    await expect(session.call(session.tools[0]!, {}, new AbortController().signal)).rejects.toThrow('not retried')
    expect(server.mutationCalls()).toBe(1)
    expect(tokenReads).toBeGreaterThan(1)
    expect(signInRequired).toBe(failure === 500 ? 0 : 1)
  })
  it.each(['disconnect', 'cancel'])('does not replay mutations after %s', async (failure) => {
    const server = await fixture({ disconnect: failure === 'disconnect', hang: failure === 'cancel' })
    const session = await connectMcp({ id: 'fixture', name: 'Fixture', environment: 'local' }, { url: `${server.origin}/mcp`, headers: {}, authentication: { method: 'oauth' } }, new AbortController().signal, { accessToken: async () => 'access-secret' })
    cleanup.push(session.close)
    const controller = new AbortController()
    const call = session.call(session.tools[0]!, {}, controller.signal)
    void call.catch(() => undefined)
    if (failure === 'cancel') {
      while (!server.mutationCalls()) await new Promise<void>((resolve) => setTimeout(resolve, 10))
      controller.abort()
    }
    await expect(call).rejects.toThrow()
    expect(server.mutationCalls()).toBe(1)
  })
  it('redacts broker-issued tokens from tool results', async () => {
    const server = await fixture()
    const session = await connectMcp({ id: 'fixture', name: 'Fixture', environment: 'local' }, { url: `${server.origin}/mcp`, headers: {}, authentication: { method: 'oauth' } }, new AbortController().signal, { accessToken: async () => 'access-secret' })
    cleanup.push(session.close)
    expect(await session.call(session.tools[0]!, {}, new AbortController().signal)).toBe('[redacted]')
  })
  it('denies private destinations, insecure URLs, redirects and oversized responses', async () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '169.254.1.2', '172.16.0.1', '192.168.0.1', '100.64.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1']) expect(publicAddress(address)).toBe(false)
    expect(publicAddress('8.8.8.8')).toBe(true)
    for (const url of ['http://example.com', 'https://user:pass@example.com', 'https://127.0.0.1', 'https://example.com/#fragment']) expect(() => oauthDestination(url)).toThrow('not allowed')
    const server = createServer((request, response) => { if (request.url === '/redirect') response.writeHead(302, { Location: 'https://example.com' }).end(); else response.end('x'.repeat(2_000_001)) })
    const origin = await listen(server)
    const fetchFn = oauthFetch(`${origin}/mcp`, new AbortController().signal)
    await expect(fetchFn(`${origin}/redirect`)).rejects.toThrow('redirects')
    await expect(fetchFn(`${origin}/large`)).rejects.toThrow('size limit')
  })
  it.each([false, true])('pins DNS results when Node automatic family selection is %s', async (autoSelectFamily) => {
    const previous = getDefaultAutoSelectFamily()
    setDefaultAutoSelectFamily(autoSelectFamily)
    try {
      const server = createServer((_request, response) => response.end('metadata'))
      const origin = await listen(server, 'localhost')
      const response = await oauthFetch(`${origin}/mcp`, new AbortController().signal)(`${origin}/metadata`)
      expect(await response.text()).toBe('metadata')
    } finally { setDefaultAutoSelectFamily(previous) }
  })
})
