import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from './settingsStore'
import { DEFAULT_DEVICE_PREFERENCES, LOCAL_SETTINGS_FIELD } from './settingsMigration'
import { cacheTheme, initializeTheme, THEME_CACHE_KEY } from '../themeCache'

const fixture = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
  vault: new Map<string, string>(),
  save: vi.fn(async () => undefined),
  invoke: vi.fn(async (command: string, args: { reference: string; secret: string }) => {
    if (command === 'local_credential_store') fixture.vault.set(args.reference, args.secret)
  }),
}))
vi.mock('@tauri-apps/plugin-store', () => ({ load: vi.fn(async () => ({
  get: async (field: string) => fixture.values.get(field),
  set: async (field: string, value: unknown) => { fixture.values.set(field, structuredClone(value)) },
  delete: async (field: string) => { fixture.values.delete(field) },
  save: fixture.save,
})) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: fixture.invoke }))

const initial = useSettingsStore.getState()
const toolIds = ['web_search', 'custom_weather', 'extension_missing', `mcp_l_${'a'.repeat(48)}`]

beforeEach(() => {
  const cached = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => cached.get(key) ?? null,
    setItem: (key: string, value: string) => { cached.set(key, value) },
  })
  fixture.values.clear()
  fixture.vault.clear()
  vi.clearAllMocks()
  fixture.save.mockResolvedValue(undefined)
  useSettingsStore.setState(initial)
})
afterEach(() => vi.unstubAllGlobals())

describe('settings store migration', () => {
  it('captures installation evidence before writing defaults, including empty existing settings', async () => {
    await useSettingsStore.getState().load()
    expect(useSettingsStore.getState().hadPriorSettings).toBe(false)
    useSettingsStore.setState(initial)
    await useSettingsStore.getState().load()
    expect(useSettingsStore.getState().hadPriorSettings).toBe(true)
    fixture.values.clear()
    fixture.values.set('enabledTools', [])
    useSettingsStore.setState(initial)
    await useSettingsStore.getState().load()
    expect(useSettingsStore.getState().hadPriorSettings).toBe(true)
  })
  it.each([undefined, null, 'unsupported', { theme: 'neon', outlineFont: 'downloaded-font', outlineFontSize: 100, followSystemMotion: 'yes' }])('uses compatible defaults for unsupported stored preferences: %j', async (preferences) => {
    fixture.values.set(LOCAL_SETTINGS_FIELD, { version: 1, accounts: [], compute: initial.localCompute, preferences })
    await useSettingsStore.getState().load()
    expect(useSettingsStore.getState().error).toBeNull()
    expect(useSettingsStore.getState().devicePreferences).toEqual(DEFAULT_DEVICE_PREFERENCES)
    expect(useSettingsStore.getState().localCompute).toEqual(initial.localCompute)
  })
  it('coalesces rapid appearance updates, persists across restart, and never writes portable configuration or document events', async () => {
    await useSettingsStore.getState().load()
    const portable = structuredClone({ agents: useSettingsStore.getState().agents, skills: useSettingsStore.getState().skills })
    fixture.invoke.mockClear()
    await Promise.all([
      useSettingsStore.getState().setDevicePreferences({ theme: 'dark' }),
      useSettingsStore.getState().setDevicePreferences({ theme: 'light', outlineFont: 'serif' }),
      useSettingsStore.getState().setDevicePreferences({ outlineFontSize: 20, followSystemMotion: false }),
    ])
    const expected = { theme: 'light', outlineFont: 'serif', outlineFontSize: 20, followSystemMotion: false }
    expect(useSettingsStore.getState().devicePreferences).toEqual(expected)
    expect(fixture.values.get(LOCAL_SETTINGS_FIELD)).toMatchObject({ preferences: expected })
    expect(window.localStorage.getItem(THEME_CACHE_KEY)).toBe('light')
    expect(fixture.invoke).not.toHaveBeenCalled()
    expect({ agents: useSettingsStore.getState().agents, skills: useSettingsStore.getState().skills }).toEqual(portable)
    useSettingsStore.setState({ devicePreferences: { ...DEFAULT_DEVICE_PREFERENCES } })
    await useSettingsStore.getState().load()
    expect(useSettingsStore.getState().devicePreferences).toEqual(expected)
  })

  it('retains optimistic preferences on failed persistence and supports retry without leaking errors', async () => {
    await useSettingsStore.getState().load()
    fixture.save.mockRejectedValueOnce(new Error('secret-bearing native failure'))
    await useSettingsStore.getState().setDevicePreferences({ theme: 'dark' })
    expect(useSettingsStore.getState().devicePreferences.theme).toBe('dark')
    expect(useSettingsStore.getState().preferenceError).toMatch(/Retry/)
    expect(useSettingsStore.getState().preferenceError).not.toContain('secret-bearing')
    expect(window.localStorage.getItem(THEME_CACHE_KEY)).toBe('system')
    await useSettingsStore.getState().setDevicePreferences({})
    expect(useSettingsStore.getState().preferenceError).toBeNull()
    expect(window.localStorage.getItem(THEME_CACHE_KEY)).toBe('dark')
    await useSettingsStore.getState().load()
    expect(useSettingsStore.getState().devicePreferences.theme).toBe('dark')
  })
  it('starts with cached appearance and reconciles it with authoritative saved preferences', async () => {
    cacheTheme('dark')
    initializeTheme()
    expect(document.documentElement.dataset.theme).toBe('dark')
    fixture.values.set(LOCAL_SETTINGS_FIELD, {
      version: 1, accounts: [], compute: initial.localCompute,
      preferences: { ...DEFAULT_DEVICE_PREFERENCES, theme: 'light' },
    })
    await useSettingsStore.getState().load()
    expect(useSettingsStore.getState().devicePreferences.theme).toBe('light')
    expect(window.localStorage.getItem(THEME_CACHE_KEY)).toBe('light')
    initializeTheme()
    expect(document.documentElement.dataset.theme).toBe('light')
  })
  it('moves secrets once and retains account selection, model, and all permission references on repeated load', async () => {
    fixture.values.set('codexAuthMode', 'api_key')
    fixture.values.set('codexModelId', 'gpt-5.4')
    fixture.values.set('openAiApiKey', 'sk-legacy-secret')
    fixture.values.set('codexOAuthCredential', {
      type: 'oauth', access: 'oauth-access', refresh: 'oauth-refresh', accountId: 'account-1', expires: 1_900_000_000_000,
    })
    fixture.values.set('enabledTools', toolIds)
    fixture.values.set('agentDefinitions', [{ id: 'agent-1', name: 'Agent', description: '', systemPrompt: 'Help.', toolIds }])
    fixture.values.set('skillDefinitions', [{ id: 'skill-1', label: 'research', description: 'Research', systemPrompt: 'Find sources.', agentId: 'agent-1', requiredToolIds: toolIds, execution: 'llm' }])
    await useSettingsStore.getState().load()
    expect(useSettingsStore.getState().error).toBeNull()
    const record = fixture.values.get(LOCAL_SETTINGS_FIELD)
    expect(record).toMatchObject({ compute: { provider: 'openai', modelId: 'gpt-5.4', credentialRef: 'local-openai' } })
    expect(useSettingsStore.getState().localCredentials.map((account) => account.id)).toEqual(['local-openai', 'local-openai-codex'])
    expect(useSettingsStore.getState().agents[0]!.toolIds).toEqual(toolIds)
    expect(useSettingsStore.getState().skills[0]).toMatchObject({ requiredToolIds: toolIds })
    expect(useSettingsStore.getState().enabledToolIds).toEqual(toolIds)
    expect(JSON.stringify([...fixture.values])).not.toMatch(/sk-legacy-secret|oauth-access|oauth-refresh/)
    expect(fixture.vault.get('local-openai')).toBe('sk-legacy-secret')
    expect(fixture.invoke).toHaveBeenCalledTimes(2)
    await useSettingsStore.getState().load()
    expect(fixture.values.get(LOCAL_SETTINGS_FIELD)).toEqual(record)
    expect(fixture.invoke).toHaveBeenCalledTimes(2)
    expect(useSettingsStore.getState().agents[0]!.toolIds).toEqual(toolIds)
    expect(useSettingsStore.getState().skills[0]).toMatchObject({ requiredToolIds: toolIds })
  })

  it('keeps legacy edits synchronized with the migration record across restart and account removal', async () => {
    await useSettingsStore.getState().load()
    await useSettingsStore.getState().setOpenAiApiKey('sk-new-key')
    await useSettingsStore.getState().setAuthMode('api_key')
    await useSettingsStore.getState().setModelId('gpt-5.4')
    await useSettingsStore.getState().load()
    expect(useSettingsStore.getState()).toMatchObject({ authMode: 'api_key', modelId: 'gpt-5.4', localCompute: { provider: 'openai', credentialRef: 'local-openai' } })
    await useSettingsStore.getState().setOpenAiApiKey('')
    await useSettingsStore.getState().load()
    expect(useSettingsStore.getState().localCredentials).toEqual([])
    expect(useSettingsStore.getState().localCompute.credentialRef).toBe('local-openai')
  })

  it('does not replace an unsupported record or delete legacy secrets on validation failure', async () => {
    fixture.values.set(LOCAL_SETTINGS_FIELD, { version: 2 })
    fixture.values.set('openAiApiKey', 'sk-preserve')
    await useSettingsStore.getState().load()
    expect(useSettingsStore.getState().error).not.toBeNull()
    expect(fixture.values.get(LOCAL_SETTINGS_FIELD)).toEqual({ version: 2 })
    expect(fixture.values.get('openAiApiKey')).toBe('sk-preserve')
    expect(fixture.invoke).not.toHaveBeenCalled()
    expect(fixture.save).not.toHaveBeenCalled()
  })
})
