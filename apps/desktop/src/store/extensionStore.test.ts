import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtensionCatalog, ExtensionManagementResponse } from '@forage/agent-runtime'
import { setExtensionManagementTransportForTests, useExtensionStore } from './extensionStore'
import { useSettingsStore } from './settingsStore'
import type { ExtensionManagementCommand } from '../agent/extensionManagementClient'

const disk = vi.hoisted(() => ({ set: vi.fn(async () => undefined), save: vi.fn(async () => undefined) }))
vi.mock('@tauri-apps/plugin-store', () => ({ load: vi.fn(async () => disk) }))

const catalog: ExtensionCatalog = {
  version: 1, revision: 'a'.repeat(64), entries: [{
    source: { kind: 'local', installationId: 'images', requestedPath: '/extensions/images', canonicalPath: '/extensions/images' },
    status: 'ready', diagnostics: [],
    tools: [{ id: 'generate_image', name: 'Generate image', description: 'Make images.', available: true, globallyAuthorized: true, diagnostics: [] }],
  }],
}

const request = vi.fn(async (command: ExtensionManagementCommand): Promise<ExtensionManagementResponse> => ({
  version: 1, kind: 'response', requestId: 'test', operation: command.operation, ok: true,
  ...(command.operation === 'inventory'
    ? { catalog: { ...catalog, entries: [] }, configuration: { version: 1, revision: 1, sources: [] }, extensionsDirectory: '/extensions' }
    : { removedInstallationId: 'images' }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  useExtensionStore.setState({ ...useExtensionStore.getInitialState(), catalog })
  useSettingsStore.setState({
    ...useSettingsStore.getInitialState(), isLoaded: true,
    enabledToolIds: ['web_search', 'generate_image', 'unrelated_tool'],
    agents: [{ id: 'general', name: 'General', description: '', systemPrompt: 'Help.', toolIds: ['web_search', 'generate_image', 'unrelated_tool'] }],
    skills: [{ id: 'draw', label: 'draw', description: '', execution: 'llm', agentId: 'general', systemPrompt: 'Draw.', requiredToolIds: ['generate_image', 'web_search'] }],
  })
  setExtensionManagementTransportForTests({ start: async () => undefined, request })
})

afterEach(() => setExtensionManagementTransportForTests(null))

describe('extension removal', () => {
  it('persists removal of its global, agent, and skill tool references', async () => {
    await useExtensionStore.getState().remove('images')

    const settings = useSettingsStore.getState()
    expect(settings.enabledToolIds).toEqual(['web_search', 'unrelated_tool'])
    expect(settings.agents[0].toolIds).toEqual(['web_search', 'unrelated_tool'])
    expect(settings.skills[0]).toMatchObject({ id: 'draw', requiredToolIds: ['web_search'] })
    expect(disk.set).toHaveBeenCalledWith('enabledTools', settings.enabledToolIds)
    expect(disk.set).toHaveBeenCalledWith('agentDefinitions', settings.agents)
    expect(disk.set).toHaveBeenCalledWith('skillDefinitions', settings.skills)
    expect(disk.save).toHaveBeenCalledOnce()
    expect(useExtensionStore.getState().catalog?.entries).toEqual([])
  })

  it('keeps tool selections when removal fails', async () => {
    request.mockRejectedValueOnce(new Error('Could not remove extension'))
    await expect(useExtensionStore.getState().remove('images')).rejects.toThrow('Could not remove extension')
    expect(useSettingsStore.getState().enabledToolIds).toContain('generate_image')
    expect(useSettingsStore.getState().agents[0].toolIds).toContain('generate_image')
    expect(disk.save).not.toHaveBeenCalled()
  })

  it('keeps tool selections when merely disabling an extension', async () => {
    await useExtensionStore.getState().disable('images')
    expect(useSettingsStore.getState().enabledToolIds).toContain('generate_image')
    expect(useSettingsStore.getState().agents[0].toolIds).toContain('generate_image')
    expect(disk.save).not.toHaveBeenCalled()
  })
})
