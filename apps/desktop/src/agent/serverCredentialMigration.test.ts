import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { migrateSelectedDesktopCredential } from './serverCredentialMigration'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

const serverCredential = {
  id: 'credential-server', provider: 'openai' as const, status: 'connected' as const,
  createdAt: '2026-09-13T08:00:00.000Z', updatedAt: '2026-09-13T08:00:00.000Z',
}

describe('server credential migration', () => {
  beforeEach(() => vi.clearAllMocks())

  it('copies the selected desktop API key into the server vault', async () => {
    vi.mocked(invoke).mockResolvedValue('sk-desktop-key-1234567890')
    const transport = { importCredential: vi.fn().mockResolvedValue(serverCredential) }

    await expect(migrateSelectedDesktopCredential(transport, 'api_key', [{
      id: 'local-openai', provider: 'openai', status: 'connected',
    }])).resolves.toEqual(serverCredential)
    expect(transport.importCredential).toHaveBeenCalledWith({
      provider: 'openai', apiKey: 'sk-desktop-key-1234567890',
    })
  })

  it('copies the selected desktop ChatGPT credential into the server vault', async () => {
    const expires = Date.now() + 3_600_000
    vi.mocked(invoke).mockResolvedValue(JSON.stringify({
      type: 'oauth', access: 'access-token-1234567890', refresh: 'refresh-token-1234567890',
      accountId: 'account-1', expires,
    }))
    const transport = { importCredential: vi.fn().mockResolvedValue({
      ...serverCredential, provider: 'openai-codex',
    }) }

    await migrateSelectedDesktopCredential(transport, 'subscription', [{
      id: 'local-openai-codex', provider: 'openai-codex', status: 'connected',
    }])
    expect(transport.importCredential).toHaveBeenCalledWith({
      provider: 'openai-codex', accessToken: 'access-token-1234567890',
      refreshToken: 'refresh-token-1234567890', accountId: 'account-1',
      expiresAt: new Date(expires).toISOString(),
    })
  })
})
