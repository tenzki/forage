import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import {
  auth, exchangeAuthorization, extractWWWAuthenticateParams, refreshAuthorization, type OAuthClientProvider, type OAuthDiscoveryState,
  type StoredOAuthClientInformation, type StoredOAuthTokens, type AuthorizationServerMetadata,
} from '@modelcontextprotocol/client'
import {
  MCP_OAUTH_TIMEOUT_MS, mcpOAuthCredentialSchema, mcpServerConfigSchema,
  type McpOAuthCredential, type McpOAuthProgress, type McpConnection, type McpServerConfig,
} from '@forage/agent-runtime'
import { discoverMcp } from './index'
import { validateOAuthBrowserDestination, oauthFetch } from './oauthFetch'

export class McpOAuthError extends Error {
  constructor(public readonly reason: 'sign_in_required' | 'unsupported' | 'denied' | 'expired' | 'failed' | 'transient') {
    super({ sign_in_required: 'MCP: Sign in again to use this server.', unsupported: 'MCP: This server does not support this public-client sign-in setup.',
      denied: 'MCP: Sign-in was denied. Try again when you are ready.', expired: 'MCP: Sign-in expired. Start a new sign-in request.',
      failed: 'MCP: Sign-in failed. Check the server setup and try again.', transient: 'MCP: Authorization service is unavailable. Retry explicitly.' }[reason])
  }
}

function credential(resource: string, discovery: OAuthDiscoveryState, information: StoredOAuthClientInformation, tokens: StoredOAuthTokens, authorizationResource?: string): McpOAuthCredential {
  return mcpOAuthCredentialSchema.parse({ resource, issuer: discovery.authorizationServerMetadata?.issuer ?? discovery.authorizationServerUrl,
    clientInformation: information, discovery, authorizationResource, tokens: {
      access_token: tokens.access_token, token_type: tokens.token_type, refresh_token: tokens.refresh_token,
      expires_in: tokens.expires_in, scope: tokens.scope,
    }, expiresAt: Date.now() + (tokens.expires_in ?? 300) * 1_000 })
}

export async function authorizeMcp(identity: Pick<McpConnection, 'id' | 'name'>, rawConfig: McpServerConfig, signal: AbortSignal,
  progress: (value: McpOAuthProgress) => void, timeoutMs = MCP_OAUTH_TIMEOUT_MS): Promise<{ credential: McpOAuthCredential; connection: McpConnection }> {
  const config = mcpServerConfigSchema.parse(rawConfig)
  if (!('url' in config) || config.authentication?.method !== 'oauth') throw new McpOAuthError('unsupported')
  const registration = config.authentication
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(Math.min(MCP_OAUTH_TIMEOUT_MS, Math.max(1, timeoutMs)))])
  const state = randomBytes(32).toString('base64url')
  const path = '/oauth/callback'
  let verifier = ''
  let discovery: OAuthDiscoveryState | undefined
  let information: StoredOAuthClientInformation | undefined
  let tokens: StoredOAuthTokens | undefined
  let authorizationResource: string | undefined
  let accept!: (value: { code: string; iss?: string }) => void
  let refuse!: (error: Error) => void
  let consumed = false
  const callback = new Promise<{ code: string; iss?: string }>((resolve, reject) => { accept = resolve; refuse = reject })
  void callback.catch(() => undefined)
  const server = createServer((request, response) => {
    const address = server.address()
    if (!address || typeof address === 'string' || request.headers.host !== `127.0.0.1:${address.port}` || !request.url || request.url.length > 12_000) { response.writeHead(400).end('Invalid sign-in response.'); return }
    let url: URL
    try { url = new URL(request.url, `http://127.0.0.1:${address.port}`) } catch { response.writeHead(400).end('Invalid sign-in response.'); return }
    if (request.method !== 'GET' || url.pathname !== path || consumed || url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== state) {
      response.writeHead(400).end('Invalid sign-in response.'); return
    }
    consumed = true
    response.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'" }).end('Return to Forage to finish connecting.')
    if (url.searchParams.has('error')) { refuse(new McpOAuthError('denied')); return }
    const code = url.searchParams.get('code')
    if (!code || code.length > 8_000 || url.searchParams.getAll('code').length !== 1 || url.searchParams.getAll('iss').length > 1) { refuse(new McpOAuthError('failed')); return }
    accept({ code, ...(url.searchParams.has('iss') ? { iss: url.searchParams.get('iss')! } : {}) })
  })
  const abort = () => { refuse(new McpOAuthError(signal.aborted ? 'failed' : 'expired')); server.closeAllConnections(); server.close() }
  deadline.addEventListener('abort', abort, { once: true })
  try {
    deadline.throwIfAborted()
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (!address || typeof address === 'string') throw new McpOAuthError('failed')
    const redirectUrl = `http://127.0.0.1:${address.port}${path}`
    const provider: OAuthClientProvider = {
      redirectUrl, clientMetadataUrl: registration.clientMetadataUrl,
      clientMetadata: { client_name: 'Forage', redirect_uris: [redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', application_type: 'native' },
      state: () => state,
      clientInformation: () => information,
      saveClientInformation: (value) => {
        const { client_secret: secret, client_secret_expires_at: _secretExpiry, ...publicInformation } = value as StoredOAuthClientInformation & {
          client_secret?: string; client_secret_expires_at?: number; token_endpoint_auth_method?: string
        }
        // Some public-client registrations include an unused secret. Discard it so
        // the SDK cannot select confidential-client authentication at exchange time.
        const method = publicInformation.token_endpoint_auth_method
        if (method && method !== 'none' || secret && method !== 'none') throw new McpOAuthError('unsupported')
        information = publicInformation
      },
      tokens: () => tokens,
      saveTokens: (value) => { tokens = value },
      saveCodeVerifier: (value) => { verifier = value }, codeVerifier: () => verifier,
      discoveryState: () => discovery, saveDiscoveryState: (value) => {
        const metadata = value.authorizationServerMetadata
        if (!metadata || !metadata.code_challenge_methods_supported?.includes('S256')
          || metadata.grant_types_supported && !metadata.grant_types_supported.includes('authorization_code')
          || metadata.token_endpoint_auth_methods_supported && !metadata.token_endpoint_auth_methods_supported.includes('none')
          || registration.clientMetadataUrl && !metadata.client_id_metadata_document_supported
          || !registration.clientId && !registration.clientMetadataUrl && !metadata.registration_endpoint) throw new McpOAuthError('unsupported')
        discovery = value
        if (registration.clientId) information = { client_id: registration.clientId, issuer: metadata.issuer }
      },
      saveResourceUrl: (value) => { authorizationResource = value },
      invalidateCredentials: () => { throw new McpOAuthError('unsupported') },
      redirectToAuthorization: async (value) => {
        await validateOAuthBrowserDestination(value, config.url, deadline)
        if (value.searchParams.get('code_challenge_method') !== 'S256' || value.searchParams.get('state') !== state || value.searchParams.get('redirect_uri') !== redirectUrl) throw new McpOAuthError('failed')
        progress({ phase: 'waiting', authorizationUrl: value.toString() })
      },
    }
    const fetchFn = oauthFetch(config.url, deadline)
    progress({ phase: 'checking' })
    const probe = await oauthFetch(config.url, AbortSignal.any([deadline, AbortSignal.timeout(20_000)]), true)(config.url, { method: 'GET', headers: { Accept: 'application/json, text/event-stream' } })
    const challenge = extractWWWAuthenticateParams(probe)
    await probe.body?.cancel().catch(() => undefined)
    if (challenge.scope && challenge.scope.length > 8_000) throw new McpOAuthError('unsupported')
    if (await auth(provider, { serverUrl: config.url, fetchFn, resourceMetadataUrl: challenge.resourceMetadataUrl, scope: challenge.scope, forceReauthorization: true }) !== 'REDIRECT') throw new McpOAuthError('unsupported')
    const returned = await callback
    deadline.throwIfAborted()
    progress({ phase: 'exchanging' })
    if (!information || !discovery) throw new McpOAuthError('failed')
    tokens = await exchangeAuthorization(discovery.authorizationServerUrl, {
      metadata: discovery.authorizationServerMetadata, clientInformation: information, authorizationCode: returned.code,
      iss: returned.iss, codeVerifier: verifier, redirectUri: redirectUrl, resource: authorizationResource, fetchFn,
    })
    const saved = credential(config.url, discovery, information, tokens, authorizationResource)
    progress({ phase: 'discovering' })
    const connection = await discoverMcp({ id: identity.id, name: identity.name, environment: 'local' }, config, deadline, { accessToken: async () => saved.tokens.access_token,
      sensitiveValues: [saved.tokens.access_token, ...(saved.tokens.refresh_token ? [saved.tokens.refresh_token] : [])] })
    deadline.throwIfAborted()
    return { credential: saved, connection: { ...connection, authentication: 'oauth', authorizationStatus: 'connected' } }
  } catch (error) {
    if (tokens && information && discovery) {
      try { await revokeMcpCredential(credential(config.url, discovery, information, tokens, authorizationResource), AbortSignal.timeout(5_000)) } catch { }
    }
    if (error instanceof McpOAuthError) throw error
    if (deadline.aborted) throw new McpOAuthError(signal.aborted ? 'failed' : 'expired')
    const name = error instanceof Error ? error.name : ''
    throw new McpOAuthError(/Registration|ClientRegistration|Unsupported|ClientFlow/.test(name) ? 'unsupported' : 'failed')
  } finally {
    deadline.removeEventListener('abort', abort)
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    verifier = ''
  }
}

export async function refreshMcpCredential(raw: McpOAuthCredential, signal: AbortSignal): Promise<McpOAuthCredential> {
  const saved = mcpOAuthCredentialSchema.parse(raw)
  if (!saved.tokens.refresh_token) throw new McpOAuthError('sign_in_required')
  try {
    const tokens = await refreshAuthorization(saved.issuer, {
      metadata: saved.discovery.authorizationServerMetadata as AuthorizationServerMetadata | undefined,
      clientInformation: saved.clientInformation as unknown as StoredOAuthClientInformation,
      refreshToken: saved.tokens.refresh_token, resource: saved.authorizationResource ?? saved.resource, fetchFn: oauthFetch(saved.resource, signal),
    })
    return credential(saved.resource, saved.discovery as unknown as OAuthDiscoveryState, saved.clientInformation as unknown as StoredOAuthClientInformation, tokens, saved.authorizationResource)
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
    throw new McpOAuthError(['invalid_grant', 'invalid_client', 'unauthorized_client', 'insufficient_scope', 'invalid_token'].includes(String(code)) ? 'sign_in_required' : 'transient')
  }
}

export async function revokeMcpCredential(raw: McpOAuthCredential, signal: AbortSignal): Promise<void> {
  const saved = mcpOAuthCredentialSchema.parse(raw)
  const metadata = saved.discovery.authorizationServerMetadata as Record<string, unknown> | undefined
  if (typeof metadata?.revocation_endpoint !== 'string' || typeof saved.clientInformation.client_id !== 'string') return
  const token = saved.tokens.refresh_token ?? saved.tokens.access_token
  await oauthFetch(saved.resource, AbortSignal.any([signal, AbortSignal.timeout(5_000)]))(metadata.revocation_endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token, token_type_hint: saved.tokens.refresh_token ? 'refresh_token' : 'access_token', client_id: saved.clientInformation.client_id }),
  }).catch(() => undefined)
}
