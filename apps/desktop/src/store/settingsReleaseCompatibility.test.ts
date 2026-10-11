import { describe, expect, it } from 'vitest'
import { computeProfileSchema, supportsProviderSelection, type ProviderCapability } from '@forage/agent-runtime'
import { DEFAULT_DEVICE_PREFERENCES, migrateLocalSettings } from './settingsMigration'

const targetCapabilities: ProviderCapability[] = [
  { provider: 'openai', authentication: 'api_key', modelIds: ['gpt-5.5'] },
  { provider: 'openai-codex', authentication: 'oauth', modelIds: ['gpt-5.5'] },
]

describe('settings release compatibility preflight', () => {
  it.each(['anthropic', 'openrouter', 'opencode-go'] as const)('blocks downgrade of %s independently in each environment without rewriting credentials or permissions', (provider) => {
    const permissions = [`mcp_l_${'a'.repeat(48)}`, `mcp_s_${'b'.repeat(48)}`, 'extension_missing']
    const local = migrateLocalSettings({
      version: 1, accounts: [{ id: `local-${provider}`, provider, status: 'connected' }],
      compute: { provider, modelId: 'fixture-model', credentialRef: `local-${provider}` },
      preferences: DEFAULT_DEVICE_PREFERENCES,
    }, { accounts: [] })
    const server = computeProfileSchema.parse({ version: 1, revision: 9, provider: 'openai', modelId: 'gpt-5.5', credentialRef: 'server-openai' })
    const before = structuredClone({ local, server, permissions })
    expect(supportsProviderSelection(targetCapabilities, local.compute)).toBe(false)
    expect(supportsProviderSelection(targetCapabilities, server)).toBe(true)
    expect(supportsProviderSelection(targetCapabilities, { ...server, provider, modelId: 'fixture-model' })).toBe(false)
    expect({ local, server, permissions }).toEqual(before)
    expect(migrateLocalSettings(local, { authMode: 'api_key', accounts: [] })).toEqual(local)
    expect(local.compute.credentialRef).not.toBe(server.credentialRef)
  })

  it('requires exact target model support and explicit repair in both environments before downgrade', () => {
    const local = { provider: 'openai' as const, modelId: 'newer-model', credentialRef: 'local-openai' }
    const server = { provider: 'openai-codex' as const, modelId: 'newer-model', credentialRef: 'server-chatgpt' }
    expect(supportsProviderSelection(targetCapabilities, local)).toBe(false)
    expect(supportsProviderSelection(targetCapabilities, server)).toBe(false)
    expect(supportsProviderSelection(undefined, local)).toBe(false)
    expect(supportsProviderSelection(targetCapabilities, { ...local, modelId: 'gpt-5.5' })).toBe(true)
    expect(supportsProviderSelection(targetCapabilities, { ...server, modelId: 'gpt-5.5' })).toBe(true)
    expect(local.modelId).toBe('newer-model')
    expect(server.modelId).toBe('newer-model')
  })
})
