// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { InMemoryProviderCredentialStore, ServerCredentialService } from './credentialService'

const encryptionKeys = [{ version: 1, keyBase64: Buffer.alloc(32, 4).toString('base64') }]

const oauth = {
  deviceUrl: 'https://auth.example/api/accounts/deviceauth/usercode',
  deviceTokenUrl: 'https://auth.example/api/accounts/deviceauth/token',
  tokenUrl: 'https://auth.example/oauth/token',
  verificationUri: 'https://auth.example/codex/device',
  redirectUri: 'https://auth.example/deviceauth/callback',
  clientId: 'client',
  timeoutSeconds: 600,
}

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('server credential service', () => {
  it('enrolls API keys and exposes only sanitized metadata', async () => {
    const service = new ServerCredentialService(new InMemoryProviderCredentialStore(), { encryptionKeys })
    const metadata = await service.enrollApiKey('owner', 'outline', 'sk-a-very-long-secret-api-key')
    expect(metadata.provider).toBe('openai')
    expect(JSON.stringify(metadata)).not.toContain('sk-a-very')
    await expect(service.resolve(metadata.id, 'owner', 'outline')).resolves.toEqual({ provider: 'openai', apiKey: 'sk-a-very-long-secret-api-key' })
    await service.disconnect(metadata.id, 'owner', 'outline')
    await expect(service.resolve(metadata.id, 'owner', 'outline')).rejects.toThrow(/authentication/i)
  })

  it('completes device authorization and extracts account identity', async () => {
    const jwtPayload = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'account-1' } })).toString('base64url')
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response(200, { device_auth_id: 'auth-1', user_code: 'ABCD-EFGH', interval: 1 }))
      .mockResolvedValueOnce(response(403, { error: 'deviceauth_authorization_pending' }))
      .mockResolvedValueOnce(response(200, { authorization_code: 'code-1', code_verifier: 'verifier-1' }))
      .mockResolvedValueOnce(response(200, { access_token: `x.${jwtPayload}.y`, refresh_token: 'refresh-secret', expires_in: 3600 }))
    const service = new ServerCredentialService(new InMemoryProviderCredentialStore(), { encryptionKeys, fetch, oauth })

    const started = await service.startDeviceAuthorization('owner', 'outline')
    expect(started.userCode).toBe('ABCD-EFGH')
    expect(started.verificationUri).toBe(oauth.verificationUri)
    expect(fetch.mock.calls[0]?.[0]).toBe(oauth.deviceUrl)

    await expect(service.pollDeviceAuthorization(started.authorizationId, 'owner', 'outline')).resolves.toMatchObject({ state: 'pending' })
    await expect(service.pollDeviceAuthorization(started.authorizationId, 'owner', 'outline')).resolves.toMatchObject({
      state: 'connected', credential: { provider: 'openai-codex', accountLabel: 'account-1' },
    })

    expect(fetch.mock.calls[1]?.[0]).toBe(oauth.deviceTokenUrl)
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({ device_auth_id: 'auth-1', user_code: 'ABCD-EFGH' })

    const exchange = fetch.mock.calls[3]
    expect(exchange?.[0]).toBe(oauth.tokenUrl)
    expect(String(exchange?.[1]?.headers?.['content-type' as never])).toBe('application/x-www-form-urlencoded')
    expect(Object.fromEntries(new URLSearchParams(String(exchange?.[1]?.body)))).toEqual({
      grant_type: 'authorization_code', client_id: 'client', code: 'code-1',
      code_verifier: 'verifier-1', redirect_uri: oauth.redirectUri,
    })

    await expect(service.resolve(started.authorizationId, 'owner', 'outline')).resolves.toMatchObject({ provider: 'openai-codex', accountId: 'account-1' })
  })

  it('reports a denied authorization without retrying it', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response(200, { device_auth_id: 'auth-1', user_code: 'ABCD-EFGH', interval: 1 }))
      .mockResolvedValueOnce(response(400, { error: 'access_denied' }))
    const service = new ServerCredentialService(new InMemoryProviderCredentialStore(), { encryptionKeys, fetch, oauth })
    const started = await service.startDeviceAuthorization('owner', 'outline')
    await expect(service.pollDeviceAuthorization(started.authorizationId, 'owner', 'outline')).resolves.toMatchObject({ state: 'denied' })
    expect((await service.metadata(started.authorizationId, 'owner', 'outline')).status).toBe('authentication_required')
  })

  it('serializes refresh rotation and marks invalid_grant authentication-required', async () => {
    const store = new InMemoryProviderCredentialStore()
    const refresh = vi.fn<typeof globalThis.fetch>(async () => response(400, { error: 'invalid_grant' }))
    const service = new ServerCredentialService(store, {
      encryptionKeys, fetch: refresh, oauth,
    })
    const id = await service.importCodexCredentialForTest('owner', 'outline', {
      accessToken: 'expired', refreshToken: 'revoked', accountId: 'account', expiresAt: '2020-01-01T00:00:00.000Z',
    })
    const results = await Promise.allSettled([service.resolve(id, 'owner', 'outline'), service.resolve(id, 'owner', 'outline')])
    expect(results.every((result) => result.status === 'rejected')).toBe(true)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect((await service.metadata(id, 'owner', 'outline')).status).toBe('authentication_required')
  })
})
