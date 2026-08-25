import { describe, expect, it } from 'vitest'
import { createAuthenticatedModelRuntime } from './runtime-auth'

describe('createAuthenticatedModelRuntime', () => {
  it('resolves standard OpenAI authentication as an API key', async () => {
    const runtime = await createAuthenticatedModelRuntime({
      providerId: 'openai',
      accessToken: 'sk-test',
    })

    await expect(runtime.getAuth('openai')).resolves.toMatchObject({
      auth: { apiKey: 'sk-test' },
    })
    expect(runtime.isUsingOAuth('openai')).toBe(false)
  })

  it('resolves ChatGPT authentication as OAuth', async () => {
    const runtime = await createAuthenticatedModelRuntime({
      providerId: 'openai-codex',
      accessToken: 'oauth-access',
      accountId: 'account-id',
      expires: Date.now() + 15 * 60_000,
    })

    await expect(runtime.getAuth('openai-codex')).resolves.toMatchObject({
      auth: { apiKey: 'oauth-access' },
      source: 'OAuth',
    })
    expect(runtime.isUsingOAuth('openai-codex')).toBe(true)
  })
})
