import { describe, expect, it } from 'vitest'
import { DEFAULT_AGENT_ID, validateAgentDraft, validateSkillDraft } from './definitions'
import { BUILTIN_TOOL_OPTIONS } from './tools'

describe('agent and skill definitions', () => {
  it('retains syntactically valid unavailable tool references', () => {
    const agent = validateAgentDraft({
      id: DEFAULT_AGENT_ID,
      name: 'Researcher',
      description: 'Finds sources',
      systemPrompt: 'Verify claims.',
      toolIds: ['web_search', 'unknown', 'web_search'],
    }, BUILTIN_TOOL_OPTIONS)

    expect(agent.toolIds).toEqual(['web_search', 'unknown'])
  })

  it('allows known tools while dropping malformed unavailable references', () => {
    const agent = validateAgentDraft({
      name: 'Illustrator',
      description: 'Creates visuals',
      systemPrompt: 'Use images only when requested.',
      toolIds: ['generate_image', 'Not valid!'],
    }, BUILTIN_TOOL_OPTIONS)

    expect(agent.toolIds).toEqual(['generate_image'])
  })

  it('requires a valid slash label and an existing agent', () => {
    const agent = validateAgentDraft({
      id: DEFAULT_AGENT_ID,
      name: 'General',
      description: 'General assistant',
      systemPrompt: 'Help the user.',
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
      execution: 'llm',
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

  it('validates generic extension executor references and preserves unknown configuration', () => {
    const skill = validateSkillDraft({
      id: 'extension-skill', execution: 'extension', label: 'label-notes', description: 'Label notes',
      executor: { extensionId: 'dev.example.notes', executorId: 'label_notes' },
      configuration: { prefix: 'Match', nested: { enabled: true } },
    }, [])
    expect(skill).toMatchObject({ execution: 'extension', configuration: { prefix: 'Match', nested: { enabled: true } } })
  })

  it('allows empty agent and skill descriptions', () => {
    const agent = validateAgentDraft({
      name: 'General', description: '  ', systemPrompt: 'Help the user.', toolIds: [],
    }, BUILTIN_TOOL_OPTIONS)
    expect(agent.description).toBe('')
    expect(validateSkillDraft({
      label: 'summarize', description: '', systemPrompt: 'Summarize.', agentId: agent.id,
    }, [agent]).description).toBe('')
    expect(validateSkillDraft({
      execution: 'extension', label: 'label-notes', description: '',
      executor: { extensionId: 'dev.example.notes', executorId: 'label_notes' },
      configuration: {},
    }, []).description).toBe('')
  })
})
