import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAuthenticatedModelRuntime, resolveModel } from './runtime-auth'
import { getProviderModels } from './provider-catalog'

afterEach(() => vi.unstubAllEnvs())

describe('createAuthenticatedModelRuntime', () => {
  it.each(['anthropic', 'openrouter', 'opencode-go', 'openai'] as const)('admits only the %s credential and exact model', async (providerId) => {
    for (const variable of ['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'OPENCODE_API_KEY', 'OPENAI_API_KEY']) vi.stubEnv(variable, 'ambient-not-admitted-key')
    const runtime = await createAuthenticatedModelRuntime({ providerId, accessToken: 'only-admitted-secret' })
    await expect(runtime.getAuth(providerId)).resolves.toMatchObject({ auth: { apiKey: 'only-admitted-secret' } })
    for (const other of ['anthropic', 'openrouter', 'opencode-go', 'openai', 'openai-codex']) {
      if (other !== providerId) expect(await runtime.getAuth(other)).toBeUndefined()
    }
    const id = getProviderModels(providerId)[0]!.id
    expect(resolveModel(runtime, providerId, id).model).toMatchObject({ provider: providerId, id })
    expect(() => resolveModel(runtime, providerId, `${id}-unavailable`)).toThrow('Model not available')
    const other = providerId === 'openai' ? 'anthropic' : 'openai'
    expect(() => resolveModel(runtime, other, getProviderModels(other)[0]!.id)).toThrow('Model not available')
    expect(() => resolveModel(runtime, 'unsupported', id)).toThrow('Model not available')
  })
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
    vi.stubEnv('OPENAI_API_KEY', 'ambient-not-admitted-key')
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
