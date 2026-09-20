import { describe, expect, it } from 'vitest'
import { confirmedConfigurationMirror, portableConfigurationHash, reconcileConfiguration } from './configurationMirror'

const configuration = (revision: number, prompt = 'Help.') => ({
  version: 3 as const, revision,
  agents: [{ id: 'agent', name: 'Agent', description: 'Agent', systemPrompt: prompt, toolIds: [] }],
  skills: [{ id: 'skill', execution: 'llm' as const, label: 'skill', description: 'Skill', systemPrompt: 'Work.', agentId: 'agent', requiredToolIds: [] }],
  customTools: [], globallyEnabledToolIds: [],
})

describe('portable configuration reconciliation', () => {
  it('distinguishes unchanged, local-only, server-only, and both-changed states', async () => {
    const base = await confirmedConfigurationMirror(configuration(2))
    await expect(reconcileConfiguration(configuration(2), configuration(2), base)).resolves.toMatchObject({ outcome: 'unchanged' })
    await expect(reconcileConfiguration(configuration(2, 'Local.'), configuration(2), base)).resolves.toMatchObject({ outcome: 'publish_local' })
    await expect(reconcileConfiguration(configuration(2), configuration(3, 'Server.'), base)).resolves.toMatchObject({ outcome: 'use_server' })
    await expect(reconcileConfiguration(configuration(2, 'Local.'), configuration(3, 'Server.'), base)).resolves.toMatchObject({ outcome: 'conflict' })
  })

  it('never guesses when both sides predate a recorded base', async () => {
    await expect(reconcileConfiguration(configuration(1), configuration(1, 'Different.'), null)).resolves.toMatchObject({ outcome: 'conflict' })
  })

  it('hashes retained unknown executor configuration independently of portable revision', async () => {
    const extension = {
      version: 3 as const, revision: 4, agents: [], customTools: [], globallyEnabledToolIds: [],
      skills: [{
        id: 'local-label', label: 'local-label', description: 'Label notes.', execution: 'extension' as const,
        executor: { extensionId: 'dev.example.notes', executorId: 'label' },
        configuration: { unfamiliar: { retained: true } },
      }],
    }

    await expect(portableConfigurationHash(extension)).resolves.toBe(await portableConfigurationHash({
      ...extension, revision: 99,
    }))
    await expect(reconcileConfiguration(
      extension,
      { ...extension, revision: 5 },
      await confirmedConfigurationMirror(extension),
    )).resolves.toMatchObject({ outcome: 'use_server' })
  })
})
