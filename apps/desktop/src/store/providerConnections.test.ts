import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from './settingsStore'
import { LOCAL_SETTINGS_FIELD } from './settingsMigration'

const fixture = vi.hoisted(() => ({ values: new Map<string, unknown>(), secrets: new Map<string, string>(), save: vi.fn(async () => {}), fetch: vi.fn() }))
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: fixture.fetch }))
vi.mock('@tauri-apps/plugin-store', () => ({ load: async () => ({
  get: async (field: string) => fixture.values.get(field), set: async (field: string, value: unknown) => { fixture.values.set(field, structuredClone(value)) },
  delete: async (field: string) => { fixture.values.delete(field) }, save: fixture.save,
}) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: async (command: string, args: { reference: string; secret?: string }) => {
  if (command === 'local_credential_store') fixture.secrets.set(args.reference, args.secret!)
  if (command === 'local_credential_remove') fixture.secrets.delete(args.reference)
  if (command === 'local_credential_load') {
    const secret = fixture.secrets.get(args.reference)
    if (!secret) throw new Error('stored credential is missing')
    return secret
  }
} }))

const initial = useSettingsStore.getState()
beforeEach(async () => {
  vi.clearAllMocks()
  fixture.values.clear()
  fixture.secrets.clear()
  fixture.save.mockResolvedValue(undefined)
  fixture.fetch.mockImplementation(async (url: string) => new Response(JSON.stringify(url.includes('openrouter') ? { data: { label: 'Key' } } : url.includes('opencode') ? { usage: {} } : { data: [{ id: 'model' }] })))
  useSettingsStore.setState(initial, true)
  await useSettingsStore.getState().load()
})

describe('device provider persistence', () => {
  it('serializes independent account connections without losing either identity or changing compute', async () => {
    const compute = useSettingsStore.getState().localCompute
    await Promise.all([
      useSettingsStore.getState().connectApiKey('anthropic', 'private-anthropic-key'),
      useSettingsStore.getState().connectApiKey('openrouter', 'private-openrouter-key'),
    ])
    expect(useSettingsStore.getState().localCredentials.map((account) => account.provider)).toEqual(['anthropic', 'openrouter'])
    expect(useSettingsStore.getState().localCompute).toEqual(compute)
    expect(JSON.stringify([...fixture.values])).not.toContain('private-')
    expect(fixture.secrets.get('local-anthropic')).toBe('private-anthropic-key')
    await useSettingsStore.getState().load()
    expect(useSettingsStore.getState().localCredentials).toHaveLength(2)
  })

  it('rolls back a replaced secret and metadata when persistence fails', async () => {
    await useSettingsStore.getState().connectApiKey('anthropic', 'private-existing-key')
    const saved = structuredClone(fixture.values.get(LOCAL_SETTINGS_FIELD))
    fixture.save.mockRejectedValueOnce(new Error('Disk full'))
    await expect(useSettingsStore.getState().connectApiKey('anthropic', 'private-replacement-key')).rejects.toThrow('Disk full')
    expect(fixture.secrets.get('local-anthropic')).toBe('private-existing-key')
    expect(fixture.values.get(LOCAL_SETTINGS_FIELD)).toEqual(saved)
  })

  it('saves compute atomically and keeps a disconnected default repairable across restart', async () => {
    await useSettingsStore.getState().connectApiKey('openai', 'private-openai-account-key')
    const selection = { provider: 'openai' as const, modelId: 'gpt-5', credentialRef: 'local-openai' }
    await useSettingsStore.getState().selectLocalCompute(selection)
    await expect(useSettingsStore.getState().selectLocalCompute({ ...selection, modelId: 'unavailable' })).rejects.toThrow('unavailable')
    expect(useSettingsStore.getState().localCompute).toEqual(selection)
    await useSettingsStore.getState().disconnectAccount(selection.credentialRef)
    await useSettingsStore.getState().load()
    expect(useSettingsStore.getState().localCompute).toEqual(selection)
    expect(useSettingsStore.getState().localCredentials).toEqual([])
    expect(fixture.secrets.has(selection.credentialRef)).toBe(false)
  })

  it('admits no account on validation failure or cancellation', async () => {
    fixture.fetch.mockResolvedValueOnce(new Response('private-invalid-key', { status: 401 }))
    await expect(useSettingsStore.getState().connectApiKey('anthropic', 'private-invalid-key')).rejects.toThrow('rejected')
    const controller = new AbortController()
    controller.abort()
    await expect(useSettingsStore.getState().connectApiKey('anthropic', 'private-cancelled-key', controller.signal)).rejects.toThrow()
    expect(fixture.secrets.size).toBe(0)
    expect(useSettingsStore.getState().localCredentials).toEqual([])
  })
})
