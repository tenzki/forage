import { describe, expect, it, vi } from 'vitest'
import type { CodexOAuthCredential } from './codexAuth'
import type { ExtensionConfiguration } from '@forage/agent-runtime'
import {
  LOCAL_CODEX_CREDENTIAL_ID,
  LOCAL_OPENAI_CREDENTIAL_ID,
  migrateLegacyCredentials,
  resolveLocalCredential,
  resolveExtensionSecretValues,
  resolveExtensionExecutorSecretValues,
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

  it('resolves only scoped secrets for sources in the admitted extension snapshot', async () => {
    const load = vi.fn(async (reference: string) => reference.endsWith('/token') ? 'secret-value' : '')
    const snapshot = {
      version: 1 as const, catalogRevision: 'a'.repeat(64), configurationRevision: 3,
      sources: [{
        installationId: 'installation-1', extensionId: 'dev.example.tools', sourceRevision: 'b'.repeat(64),
        entryDigest: 'c'.repeat(64), toolIds: ['text_stats'], hooks: [],
      }],
    }
    const configuration = {
      version: 1 as const, revision: 3, sources: [{
        installationId: 'installation-1', source: { kind: 'local' as const, path: '/tmp/tools' }, enabled: true,
        trust: { accepted: true as const, extensionId: 'dev.example.tools' }, settings: {},
        secretReferences: { token: 'forage-extension/installation-1/token' },
      }],
    }

    await expect(resolveExtensionSecretValues(snapshot, configuration, { load })).resolves.toEqual({
      'installation-1': { token: 'secret-value' },
    })
    expect(load).toHaveBeenCalledWith('forage-extension/installation-1/token')
    expect(() => JSON.stringify(configuration)).not.toThrow()
    expect(JSON.stringify(configuration)).not.toContain('secret-value')
  })

  it('resolves only the selected executor source secrets against the device-local extension revision', async () => {
    const load = vi.fn(async () => 'executor-secret')
    const snapshot = {
      version: 1 as const, catalogRevision: 'a'.repeat(64), configurationRevision: 8,
      source: { installationId: 'executor-1', extensionId: 'dev.example.executor', sourceRevision: 'source-1',
        entryDigest: 'b'.repeat(64), executorId: 'summarize' },
    }
    const configuration: ExtensionConfiguration = { version: 1, revision: 8, sources: [{
      installationId: 'executor-1', source: { kind: 'local' as const, path: '/tmp/executor' }, enabled: true,
      trust: { accepted: true as const, extensionId: 'dev.example.executor' }, settings: {},
      secretReferences: { token: 'forage-extension/executor-1/token' },
    }, {
      installationId: 'unrelated', source: { kind: 'local' as const, path: '/tmp/unrelated' }, enabled: true,
      trust: { accepted: true as const, extensionId: 'dev.example.unrelated' }, settings: {},
      secretReferences: { other: 'forage-extension/unrelated/other' },
    }] }

    await expect(resolveExtensionExecutorSecretValues(snapshot, configuration, { load })).resolves.toEqual({ token: 'executor-secret' })
    expect(load).toHaveBeenCalledTimes(1)
    expect(load).toHaveBeenCalledWith('forage-extension/executor-1/token')
    await expect(resolveExtensionExecutorSecretValues({ ...snapshot, configurationRevision: 7 }, configuration, { load }))
      .rejects.toThrow(/configuration changed/i)
  })
})
