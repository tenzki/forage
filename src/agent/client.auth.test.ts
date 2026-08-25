import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodexOAuthCredential } from './codexAuth'

const mocks = vi.hoisted(() => ({ validCodexCredential: vi.fn() }))

vi.mock('./codexAuth', async (importOriginal) => ({
  ...await importOriginal<typeof import('./codexAuth')>(),
  validCodexCredential: mocks.validCodexCredential,
}))

import { resolveCodexAuth } from './client'

const original: CodexOAuthCredential = {
  type: 'oauth',
  access: 'old-access',
  refresh: 'old-refresh',
  expires: 1,
  accountId: 'old-account',
}

const refreshed: CodexOAuthCredential = {
  type: 'oauth',
  access: 'new-access',
  refresh: 'new-refresh',
  expires: 2_000_000_000_000,
  accountId: 'new-account',
}

beforeEach(() => vi.clearAllMocks())

describe('resolveCodexAuth', () => {
  it('returns a trimmed API key', async () => {
    await expect(resolveCodexAuth({
      mode: 'api_key',
      apiKey: ' test-key ',
      oauthCredential: null,
      modelId: 'gpt-test',
    })).resolves.toEqual({ mode: 'api_key', accessToken: 'test-key' })
  })

  it('returns and persists metadata from the refreshed OAuth credential', async () => {
    mocks.validCodexCredential.mockResolvedValue(refreshed)
    const onCredentialRefresh = vi.fn(async () => undefined)

    await expect(resolveCodexAuth({
      mode: 'subscription',
      apiKey: '',
      oauthCredential: original,
      modelId: 'gpt-test',
      onCredentialRefresh,
    })).resolves.toEqual({
      mode: 'subscription',
      accessToken: 'new-access',
      accountId: 'new-account',
      expires: 2_000_000_000_000,
    })
    expect(onCredentialRefresh).toHaveBeenCalledWith(refreshed)
  })
})
