import { describe, expect, it } from 'vitest'
import { MODEL_PROVIDERS, computeProfileSchema, providerCapabilitiesSchema } from '@forage/agent-runtime'
import { getProviderCapabilities, getProviderModels } from './provider-catalog'
import { createAuthenticatedModelRuntime, resolveModel } from './runtime-auth'

describe('pinned Pi provider catalog', () => {
  it.each(MODEL_PROVIDERS)('maps $label to $runtimeProviderId with $authentication', async (descriptor) => {
    const models = getProviderModels(descriptor.id)
    expect(models.length).toBeGreaterThan(0)
    expect(models.every((model) => model.provider === descriptor.runtimeProviderId)).toBe(true)
    const runtime = await createAuthenticatedModelRuntime(descriptor.id === 'openai-codex'
      ? { providerId: descriptor.id, accessToken: 'catalog-test-token', accountId: 'catalog-account', expires: Date.now() + 60_000 }
      : { providerId: descriptor.id, accessToken: 'catalog-test-key' })
    expect(runtime.getProvider(descriptor.id)?.auth[descriptor.authentication === 'api_key' ? 'apiKey' : 'oauth']).toBeDefined()
    if (descriptor.authentication === 'api_key') {
      await runtime.setRuntimeApiKey(descriptor.id, 'catalog-test-key')
      await expect(runtime.getAuth(descriptor.id)).resolves.toMatchObject({ auth: { apiKey: 'catalog-test-key' } })
      expect(runtime.isUsingOAuth(descriptor.id)).toBe(false)
    }
    for (const model of models) {
      expect(computeProfileSchema.safeParse({ version: 1, revision: 1, provider: descriptor.id, modelId: model.id, credentialRef: 'test-credential' }).success).toBe(true)
      expect(resolveModel(runtime, descriptor.runtimeProviderId, model.id).model.id).toBe(model.id)
    }
    expect(() => resolveModel(runtime, descriptor.runtimeProviderId, 'forage-nonexistent-model')).toThrow('Model not available')
    const otherProvider = descriptor.id === 'anthropic' ? 'openai' : 'anthropic'
    expect(() => resolveModel(runtime, descriptor.id, getProviderModels(otherProvider)[0]!.id)).toThrow('Model not available')
  })

  it('exposes only explicitly enabled provider capabilities, from the installed catalog', () => {
    const capabilities = getProviderCapabilities(['openai', 'openai-codex'])
    expect(providerCapabilitiesSchema.parse(capabilities)).toEqual(capabilities)
    expect(capabilities.map((entry) => entry.provider)).toEqual(['openai', 'openai-codex'])
    expect(providerCapabilitiesSchema.safeParse(getProviderCapabilities(MODEL_PROVIDERS.map((provider) => provider.id))).success).toBe(true)
  })
})
