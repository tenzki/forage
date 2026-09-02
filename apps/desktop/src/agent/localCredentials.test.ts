import { describe, expect, it, vi } from 'vitest'
import type { CodexOAuthCredential } from './codexAuth'
import {
  LOCAL_CODEX_CREDENTIAL_ID,
  LOCAL_OPENAI_CREDENTIAL_ID,
  migrateLegacyCredentials,
  resolveLocalCredential,
} from './localCredentials'

describe('local executor credentials', () => {
  it('moves legacy API-key and OAuth secrets into the native vault and returns only metadata', async () => {
    const oauth: CodexOAuthCredential = {
      type: 'oauth', access: 'oauth-access', refresh: 'oauth-refresh', expires: 1_800_000_000_000,
      accountId: 'account-1',
    }
    const store = vi.fn(async () => undefined)

    const metadata = await migrateLegacyCredentials({ apiKey: 'sk-legacy-secret', oauth }, { store })

    expect(store).toHaveBeenCalledWith(LOCAL_OPENAI_CREDENTIAL_ID, 'sk-legacy-secret')
    expect(store).toHaveBeenCalledWith(LOCAL_CODEX_CREDENTIAL_ID, JSON.stringify(oauth))
    expect(metadata).toEqual([
      expect.objectContaining({ id: LOCAL_OPENAI_CREDENTIAL_ID, provider: 'openai', status: 'connected' }),
      expect.objectContaining({ id: LOCAL_CODEX_CREDENTIAL_ID, provider: 'openai-codex', accountLabel: 'account-1' }),
    ])
    expect(JSON.stringify(metadata)).not.toContain('legacy-secret')
    expect(JSON.stringify(metadata)).not.toContain('oauth-access')
    expect(JSON.stringify(metadata)).not.toContain('oauth-refresh')
  })

  it('resolves a selected reference only for the active local execution call', async () => {
    const load = vi.fn(async () => JSON.stringify({
      type: 'oauth', access: 'access', refresh: 'refresh', expires: 1_800_000_000_000, accountId: 'account-1',
    }))

    await expect(resolveLocalCredential({
      id: LOCAL_CODEX_CREDENTIAL_ID,
      provider: 'openai-codex',
      status: 'connected',
      accountLabel: 'account-1',
      expiresAt: '2027-01-15T08:00:00.000Z',
    }, { load })).resolves.toMatchObject({ mode: 'subscription', oauthCredential: { access: 'access' } })
    expect(load).toHaveBeenCalledWith(LOCAL_CODEX_CREDENTIAL_ID)
  })

  it('rejects malformed vault content without returning it as a provider secret', async () => {
    await expect(resolveLocalCredential({
      id: LOCAL_CODEX_CREDENTIAL_ID,
      provider: 'openai-codex',
      status: 'connected',
    }, { load: async () => '{"accessToken":"only"}' })).rejects.toThrow(/invalid/i)
  })
})
