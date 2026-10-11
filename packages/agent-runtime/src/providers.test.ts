import { describe, expect, it } from 'vitest'
import { computeProfileSchema, credentialReferenceSchema, portableAgentConfigurationSchema } from './contracts'
import { MODEL_PROVIDERS, providerCapabilitiesSchema, supportsProviderSelection } from './providers'

describe('model provider contracts', () => {
  it.each(MODEL_PROVIDERS)('accepts $id without adding compute to portable agents', ({ id }) => {
    const profile = { version: 1, revision: 1, provider: id, modelId: 'model/name', credentialRef: 'credential-1' }
    expect(computeProfileSchema.parse(profile)).toEqual(profile)
    expect(credentialReferenceSchema.parse({ id: 'credential-1', provider: id }).provider).toBe(id)
    expect(portableAgentConfigurationSchema.safeParse({ ...profile, agents: [], skills: [] }).success).toBe(false)
  })

  it('keeps legacy profiles unchanged and rejects unknown providers and secrets', () => {
    for (const provider of ['openai', 'openai-codex']) {
      const profile = { version: 1, revision: 7, provider, modelId: 'gpt-5.5', credentialRef: 'existing-reference' }
      expect(computeProfileSchema.parse(profile)).toEqual(profile)
      expect(computeProfileSchema.safeParse({ ...profile, apiKey: 'secret' }).success).toBe(false)
    }
    expect(computeProfileSchema.safeParse({ version: 1, revision: 1, provider: 'opencode', modelId: 'model', credentialRef: 'ref' }).success).toBe(false)
  })

  it('rejects incompatible auth and duplicate capabilities; absent metadata grants nothing', () => {
    const capability = { provider: 'openai' as const, authentication: 'api_key' as const, modelIds: ['gpt-5.5'] }
    expect(providerCapabilitiesSchema.parse([capability])).toEqual([capability])
    expect(providerCapabilitiesSchema.safeParse([{ ...capability, authentication: 'oauth' }]).success).toBe(false)
    expect(providerCapabilitiesSchema.safeParse([{ ...capability, provider: 'openai-codex' }]).success).toBe(false)
    expect(providerCapabilitiesSchema.safeParse([capability, capability]).success).toBe(false)
    expect(providerCapabilitiesSchema.safeParse([{ ...capability, modelIds: ['same', 'same'] }]).success).toBe(false)
    expect(supportsProviderSelection(undefined, { provider: 'anthropic', modelId: 'claude' })).toBe(false)
    expect(supportsProviderSelection([capability], { provider: 'openai', modelId: 'gpt-5.5' })).toBe(true)
    expect(supportsProviderSelection([capability], { provider: 'openai', modelId: 'unknown' })).toBe(false)
    expect(supportsProviderSelection([capability], { provider: 'anthropic', modelId: 'gpt-5.5' })).toBe(false)
  })
})
