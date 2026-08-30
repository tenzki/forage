import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetch } from '@tauri-apps/plugin-http'
import { openUrl } from '@tauri-apps/plugin-opener'
import {
  loginWithChatGpt,
  validCodexCredential,
  type CodexOAuthCredential,
} from './codexAuth'

vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }))

const mockedFetch = vi.mocked(fetch)
const mockedOpenUrl = vi.mocked(openUrl)

function accessToken(accountId = 'account-123'): string {
  const payload = btoa(JSON.stringify({
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
  })).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
  return `header.${payload}.signature`
}

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('Codex authentication', () => {
  it('completes the ChatGPT device-code flow and extracts the account ID', async () => {
    vi.useFakeTimers()
    mockedFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({
        device_auth_id: 'device-1',
        user_code: 'ABCD-EFGH',
        interval: 1,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        authorization_code: 'authorization-code',
        code_verifier: 'code-verifier',
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: accessToken(),
        refresh_token: 'refresh-token',
        expires_in: 3600,
      }), { status: 200 }))

    const onDeviceCode = vi.fn()
    const login = loginWithChatGpt(onDeviceCode)
    await vi.advanceTimersByTimeAsync(1_000)
    const credential = await login

    expect(mockedOpenUrl).toHaveBeenCalledWith('https://auth.openai.com/codex/device')
    expect(onDeviceCode).toHaveBeenCalledWith({
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://auth.openai.com/codex/device',
    })
    expect(credential.accountId).toBe('account-123')
    expect(credential.type).toBe('oauth')
  })

  it('reuses a subscription token while it has enough validity remaining', async () => {
    const credential: CodexOAuthCredential = {
      type: 'oauth',
      access: accessToken(),
      refresh: 'refresh-token',
      expires: Date.now() + 10 * 60 * 1000,
      accountId: 'account-123',
    }

    await expect(validCodexCredential(credential)).resolves.toBe(credential)
    expect(mockedFetch).not.toHaveBeenCalled()
  })
})
