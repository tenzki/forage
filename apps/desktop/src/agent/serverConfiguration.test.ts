import { describe, expect, it, vi } from 'vitest'
import {
  buildServerAgentConfiguration,
  ensureServerAgentConfiguration,
  synchronizeServerAgentConfiguration,
} from './serverConfiguration'

const settings = {
  modelId: 'gpt-global',
  enabledToolIds: ['web_search'],
  customTools: [{ id: 'weather', name: 'Weather', description: 'Forecasts', urlTemplate: 'https://example.com/{{city}}' }],
  agents: [{
    id: 'general', name: 'General', description: 'General agent', systemPrompt: 'Help.', modelId: '', toolIds: ['web_search'],
  }],
  skills: [{
    id: 'research', label: 'research', description: 'Research', systemPrompt: 'Research.', agentId: 'general', requiredToolIds: [],
  }],
}

describe('server agent configuration', () => {
  it('copies portable settings without environment compute bindings', () => {
    expect(buildServerAgentConfiguration(settings, 1)).toEqual({
      version: 3,
      revision: 1,
      agents: [{
        id: 'general', name: 'General', description: 'General agent', systemPrompt: 'Help.', toolIds: ['web_search'],
      }],
      skills: settings.skills.map((skill) => ({ ...skill, execution: 'llm' })),
      customTools: settings.customTools,
      globallyEnabledToolIds: settings.enabledToolIds,
    })
  })

  it('never embeds an explicitly enrolled credential', () => {
    expect(buildServerAgentConfiguration(settings, 2, 'server-credential').agents[0])
      .not.toHaveProperty('credentialRef')
  })

  it('publishes unavailable executor references and bounded unknown config without local authority', () => {
    const extensionSkill = {
      id: 'local-label', label: 'local-label', description: 'Label notes.', execution: 'extension' as const,
      executor: { extensionId: 'dev.example.notes', executorId: 'label' },
      configuration: { unfamiliar: { retained: true }, values: [1, 2, 3] },
    }
    const configuration = buildServerAgentConfiguration({
      ...settings, agents: [], skills: [extensionSkill],
    }, 9)

    expect(configuration.skills).toEqual([extensionSkill])
    expect(configuration.revision).toBe(9)
    expect(JSON.stringify(configuration)).not.toMatch(/installationId|catalogRevision|configurationRevision|canonicalPath|trustStatus/)
  })

  it('migrates legacy UUID custom-tool references to their valid tool names', () => {
    const legacyToolId = 'b80ff0b8-7c86-4b52-bcf2-279059e25963'
    const configuration = buildServerAgentConfiguration({
      ...settings,
      customTools: [{ ...settings.customTools[0]!, id: legacyToolId }],
      enabledToolIds: ['web_search', legacyToolId],
      agents: [{ ...settings.agents[0]!, toolIds: ['web_search', legacyToolId] }],
      skills: [{ ...settings.skills[0]!, requiredToolIds: [legacyToolId] }],
    }, 1)

    expect(configuration.customTools[0]?.id).toBe('weather')
    expect(configuration.globallyEnabledToolIds).toEqual(['web_search', 'weather'])
    expect(configuration.agents[0]?.toolIds).toEqual(['web_search', 'weather'])
    expect(configuration.skills[0]?.execution).toBe('llm')
    if (configuration.skills[0]?.execution === 'llm') {
      expect(configuration.skills[0].requiredToolIds).toEqual(['weather'])
    }
  })

  it('repairs a legacy server connection with no published configuration', async () => {
    const configuration = buildServerAgentConfiguration(settings, 1)
    const transport = {
      configuration: vi.fn().mockRejectedValue(new Error('conflict: No server agent configuration has been published.')),
      publishConfiguration: vi.fn().mockResolvedValue({ configuration }),
    }

    await expect(ensureServerAgentConfiguration(transport, settings)).resolves.toEqual({ configuration })
    expect(transport.publishConfiguration).toHaveBeenCalledWith({ baseRevision: 0, configuration })
  })

  it('does not hide a publication rejection behind the original missing error', async () => {
    const transport = {
      configuration: vi.fn().mockRejectedValue(new Error('conflict: No server agent configuration has been published.')),
      publishConfiguration: vi.fn().mockRejectedValue(new Error('conflict: Required tool is unavailable: generate_image')),
    }

    await expect(ensureServerAgentConfiguration(transport, settings))
      .rejects.toThrow('Required tool is unavailable: generate_image')
    expect(transport.configuration).toHaveBeenCalledTimes(1)
  })

  it('syncs local settings over the current revision without mixing in compute', async () => {
    const current = buildServerAgentConfiguration(settings, 3, 'credential-1')
    const transport = {
      configuration: vi.fn().mockResolvedValue({ configuration: current }),
      publishConfiguration: vi.fn().mockImplementation(async ({ configuration }) => ({ configuration })),
    }

    const published = await synchronizeServerAgentConfiguration(transport, settings)
    expect(published.configuration.revision).toBe(4)
    expect(published.configuration.agents[0]).not.toHaveProperty('credentialRef')
    expect(transport.publishConfiguration).toHaveBeenCalledWith(expect.objectContaining({ baseRevision: 3 }))
  })
})
