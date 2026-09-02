import { describe, expect, it } from 'vitest'
import { DEFAULT_AGENT_ID, validateAgentDraft, validateSkillDraft } from './definitions'
import { BUILTIN_TOOL_OPTIONS } from './tools'

describe('agent and skill definitions', () => {
  it('bounds an agent tool allowlist to known tools', () => {
    const agent = validateAgentDraft({
      id: DEFAULT_AGENT_ID,
      name: 'Researcher',
      description: 'Finds sources',
      systemPrompt: 'Verify claims.',
      modelId: '',
      toolIds: ['web_search', 'unknown', 'web_search'],
    }, BUILTIN_TOOL_OPTIONS)

    expect(agent.toolIds).toEqual(['web_search'])
  })

  it('allows the image tool per agent while dropping unknown tools', () => {
    const agent = validateAgentDraft({
      name: 'Illustrator',
      description: 'Creates visuals',
      systemPrompt: 'Use images only when requested.',
      modelId: '',
      toolIds: ['generate_image', 'unknown'],
    }, BUILTIN_TOOL_OPTIONS)

    expect(agent.toolIds).toEqual(['generate_image'])
  })

  it('requires a valid slash label and an existing agent', () => {
    const agent = validateAgentDraft({
      id: DEFAULT_AGENT_ID,
      name: 'General',
      description: 'General assistant',
      systemPrompt: 'Help the user.',
      modelId: '',
      toolIds: [],
    }, BUILTIN_TOOL_OPTIONS)

    expect(() => validateSkillDraft({
      label: 'Not valid!',
      description: 'Invalid command',
      systemPrompt: 'Run.',
      agentId: agent.id,
    }, [agent])).toThrow(/Slash commands/)
    expect(() => validateSkillDraft({
      label: 'summarize',
      description: 'Summarize a branch',
      systemPrompt: 'Summarize.',
      agentId: 'missing',
    }, [agent])).toThrow(/Choose an agent/)
  })

  it('discards obsolete persisted context strategy fields', () => {
    const agent = validateAgentDraft({
      id: DEFAULT_AGENT_ID,
      name: 'General',
      description: 'General assistant',
      systemPrompt: 'Help the user.',
      modelId: '',
      toolIds: [],
    }, BUILTIN_TOOL_OPTIONS)
    const skill = validateSkillDraft({
      label: 'summarize',
      description: 'Summarize a branch',
      systemPrompt: 'Summarize.',
      agentId: agent.id,
      contextStrategy: { preset: 'lineage', selectors: [{ kind: 'ancestors' }] },
    }, [agent])

    expect(skill).toEqual({
      id: expect.any(String),
      label: 'summarize',
      description: 'Summarize a branch',
      systemPrompt: 'Summarize.',
      agentId: agent.id,
      requiredToolIds: [],
    })
    expect(skill).not.toHaveProperty('contextStrategy')
  })

  it('normalizes required tools against the assigned agent allowlist', () => {
    const agent = validateAgentDraft({
      id: DEFAULT_AGENT_ID,
      name: 'Researcher',
      description: 'Research assistant',
      systemPrompt: 'Research.',
      modelId: '',
      toolIds: ['web_fetch'],
    }, BUILTIN_TOOL_OPTIONS)

    expect(validateSkillDraft({
      label: 'research',
      description: 'Research',
      systemPrompt: 'Use sources.',
      agentId: agent.id,
      requiredToolIds: ['web_fetch', 'web_fetch'],
    }, [agent]).requiredToolIds).toEqual(['web_fetch'])
    expect(() => validateSkillDraft({
      label: 'research',
      description: 'Research',
      systemPrompt: 'Use sources.',
      agentId: agent.id,
      requiredToolIds: ['youtube_transcript'],
    }, [agent])).toThrow(/required tool/i)
  })
})
