import { describe, expect, it } from 'vitest'
import { confirmedConfigurationMirror, reconcileConfiguration } from './configurationMirror'

const configuration = (revision: number, prompt = 'Help.') => ({
  version: 2 as const, revision,
  agents: [{ id: 'agent', name: 'Agent', description: 'Agent', systemPrompt: prompt, toolIds: [] }],
  skills: [{ id: 'skill', label: 'skill', description: 'Skill', systemPrompt: 'Work.', agentId: 'agent', requiredToolIds: [] }],
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
})
