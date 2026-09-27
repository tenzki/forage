import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from './settingsStore'

const disk = vi.hoisted(() => ({ set: vi.fn(async () => undefined), save: vi.fn(async () => undefined) }))
vi.mock('@tauri-apps/plugin-store', () => ({ load: vi.fn(async () => disk) }))
const initial = useSettingsStore.getState()
const id = `mcp_l_${'a'.repeat(48)}`
beforeEach(() => {
  vi.clearAllMocks()
  disk.save.mockResolvedValue(undefined)
  useSettingsStore.setState({ ...initial, enabledToolIds: ['web_search'], agents: [
    { id: 'selected', name: 'Selected', description: '', systemPrompt: 'Help.', toolIds: ['web_search'] },
    { id: 'other', name: 'Other', description: '', systemPrompt: 'Help.', toolIds: [] },
  ] })
})

describe('MCP access grant', () => {
  it('enables reviewed tools and adds them only to selected agents, retaining existing access', async () => {
    await useSettingsStore.getState().grantMcpToolAccess([id], ['selected'])
    expect(useSettingsStore.getState().enabledToolIds).toEqual(['web_search', id])
    expect(useSettingsStore.getState().agents.map((agent) => agent.toolIds)).toEqual([['web_search', id], []])
    expect(disk.save).toHaveBeenCalledTimes(1)
  })
  it('rejects missing agents, invalid tools, and tool limit overflow without saving', async () => {
    await expect(useSettingsStore.getState().grantMcpToolAccess([id], ['missing'])).rejects.toThrow('existing agent')
    await expect(useSettingsStore.getState().grantMcpToolAccess(['not_mcp'], ['selected'])).rejects.toThrow('Choose MCP tools')
    const ids = Array.from({ length: 64 }, (_, i) => `mcp_l_${i.toString(16).padStart(48, '0')}`)
    await expect(useSettingsStore.getState().grantMcpToolAccess(ids, ['selected'])).rejects.toThrow('64 tools')
    expect(disk.save).not.toHaveBeenCalled()
  })
  it('leaves active permissions unchanged when persistence fails', async () => {
    disk.save.mockRejectedValueOnce(new Error('Disk unavailable'))
    await expect(useSettingsStore.getState().grantMcpToolAccess([id], ['selected'])).rejects.toThrow('Disk unavailable')
    expect(useSettingsStore.getState().enabledToolIds).toEqual(['web_search'])
    expect(useSettingsStore.getState().agents[0]!.toolIds).toEqual(['web_search'])
  })
})
