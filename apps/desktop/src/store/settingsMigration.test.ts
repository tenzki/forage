import { describe, expect, it } from 'vitest'
import { DEFAULT_DEVICE_PREFERENCES, localSettingsSchema, migrateLocalSettings } from './settingsMigration'

const accounts = [
  { id: 'existing-openai', provider: 'openai', status: 'connected' },
  { id: 'existing-chatgpt', provider: 'openai-codex', status: 'authentication_required', accountLabel: 'account-1' },
]

describe('device settings migration', () => {
  it.each(['api_key', 'subscription'])('preserves %s selection and credential identity repeatedly', (authMode) => {
    const legacy = { authMode, modelId: 'gpt-5.4', accounts }
    const migrated = migrateLocalSettings(undefined, legacy)
    expect(migrated.accounts).toEqual(accounts)
    expect(migrated.compute).toEqual({
      provider: authMode === 'api_key' ? 'openai' : 'openai-codex', modelId: 'gpt-5.4',
      credentialRef: authMode === 'api_key' ? 'existing-openai' : 'existing-chatgpt',
    })
    expect(migrated.preferences).toEqual(DEFAULT_DEVICE_PREFERENCES)
    expect(migrateLocalSettings(migrated, { authMode: 'changed', modelId: 'changed', accounts: [] })).toEqual(migrated)
  })

  it('retains a missing default for repair rather than choosing the other account', () => {
    const migrated = migrateLocalSettings(undefined, { authMode: 'subscription', accounts: accounts.slice(0, 1) })
    expect(migrated.compute.credentialRef).toBe('local-openai-codex')
    expect(migrated.compute.provider).toBe('openai-codex')
  })

  it('retains supported current preferences and safely defaults invalid individual values', () => {
    const migrated = migrateLocalSettings(undefined, { accounts: [] })
    const stored = { ...migrated, preferences: { theme: 'dark', outlineFont: 'unknown', outlineFontSize: 15, followSystemMotion: false } }
    expect(migrateLocalSettings(stored, { accounts: [] }).preferences).toEqual({
      theme: 'dark', outlineFont: 'default', outlineFontSize: 'default', followSystemMotion: false,
    })
    expect(migrateLocalSettings({ ...migrated, preferences: { theme: 'light', outlineFont: 'mono', outlineFontSize: 24, followSystemMotion: true } }, { accounts: [] }).preferences.outlineFontSize).toBe(24)
  })

  it('rejects secrets, conflicting credential identities, duplicate accounts, and future versions without rewriting them', () => {
    const migrated = migrateLocalSettings(undefined, { accounts })
    expect(localSettingsSchema.safeParse({ ...migrated, accounts: [{ ...accounts[0], apiKey: 'secret' }] }).success).toBe(false)
    expect(localSettingsSchema.safeParse({ ...migrated, accounts: [accounts[0], accounts[0]] }).success).toBe(false)
    expect(localSettingsSchema.safeParse({ ...migrated, compute: { ...migrated.compute, credentialRef: 'existing-openai' } }).success).toBe(false)
    expect(() => migrateLocalSettings({ ...migrated, version: 2 }, { accounts: [] })).toThrow()
  })
})
