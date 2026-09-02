// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { InMemoryProviderCredentialStore, ServerCredentialService } from './credentialService'

const encryptionKeys = [{ version: 1, keyBase64: Buffer.alloc(32, 4).toString('base64') }]

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
      .mockResolvedValueOnce(response(200, { device_code: 'device-secret', user_code: 'ABCD-EFGH', verification_uri: 'https://auth.example/device', expires_in: 600, interval: 1 }))
      .mockResolvedValueOnce(response(400, { error: 'authorization_pending' }))
      .mockResolvedValueOnce(response(200, { access_token: `x.${jwtPayload}.y`, refresh_token: 'refresh-secret', expires_in: 3600 }))
    const service = new ServerCredentialService(new InMemoryProviderCredentialStore(), {
      encryptionKeys, fetch, oauth: { deviceUrl: 'https://auth.example/device/start', tokenUrl: 'https://auth.example/token', clientId: 'client' },
    })
    const started = await service.startDeviceAuthorization('owner', 'outline')
    expect(started.userCode).toBe('ABCD-EFGH')
    await expect(service.pollDeviceAuthorization(started.authorizationId, 'owner', 'outline')).resolves.toMatchObject({ state: 'pending' })
    await expect(service.pollDeviceAuthorization(started.authorizationId, 'owner', 'outline')).resolves.toMatchObject({
      state: 'connected', credential: { provider: 'openai-codex', accountLabel: 'account-1' },
    })
    await expect(service.resolve(started.authorizationId, 'owner', 'outline')).resolves.toMatchObject({ provider: 'openai-codex', accountId: 'account-1' })
  })

  it('serializes refresh rotation and marks invalid_grant authentication-required', async () => {
    const store = new InMemoryProviderCredentialStore()
    const refresh = vi.fn<typeof globalThis.fetch>(async () => response(400, { error: 'invalid_grant' }))
    const service = new ServerCredentialService(store, {
      encryptionKeys, fetch: refresh, oauth: { deviceUrl: 'https://auth.example/device', tokenUrl: 'https://auth.example/token', clientId: 'client' },
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
