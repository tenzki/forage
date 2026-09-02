import { describe, expect, it } from 'vitest'
import {
  activityEventSchema,
  agentConfigurationSchema,
  agentDefinitionSchema,
  customToolDefinitionSchema,
  parseRunSnapshot,
  parseStructuredResult,
  runInputSchema,
  skillDefinitionSchema,
} from './contracts'

const agent = {
  id: 'research-agent',
  name: 'Research agent',
  description: 'Finds and verifies sources.',
  systemPrompt: 'Research the supplied material.',
  modelId: 'gpt-5',
  toolIds: ['web_search', 'web_fetch'],
}

const skill = {
  id: 'research',
  label: 'research',
  description: 'Research a captured URL.',
  systemPrompt: 'Return concise notes with sources.',
  agentId: agent.id,
  requiredToolIds: ['web_fetch'],
}

describe('agent runtime contracts', () => {
  it('parses strict bounded definitions', () => {
    expect(agentDefinitionSchema.parse(agent)).toEqual(agent)
    expect(skillDefinitionSchema.parse(skill)).toEqual(skill)
    expect(() => agentDefinitionSchema.parse({ ...agent, name: 'x'.repeat(81) })).toThrow()
    expect(() => agentDefinitionSchema.parse({ ...agent, unknown: true })).toThrow()
    expect(() => skillDefinitionSchema.parse({ ...skill, label: 'Not valid!' })).toThrow()
  })

  it('rejects duplicate identifiers and dangling skill references deterministically', () => {
    expect(() => agentConfigurationSchema.parse({
      version: 1,
      revision: 3,
      agents: [agent, { ...agent }],
      skills: [skill],
      customTools: [],
      globallyEnabledToolIds: ['web_search'],
    })).toThrow(/agent id/i)

    expect(() => agentConfigurationSchema.parse({
      version: 1,
      revision: 3,
      agents: [agent],
      skills: [{ ...skill, agentId: 'missing' }],
      customTools: [],
      globallyEnabledToolIds: ['web_search'],
    })).toThrow(/agent/i)
  })

  it('validates custom tools and rejects embedded credentials', () => {
    expect(customToolDefinitionSchema.parse({
      id: 'github_issues',
      name: 'GitHub issues',
      description: 'Read public repository issues.',
      urlTemplate: 'https://api.github.com/repos/{{owner}}/{{repo}}/issues',
    }).id).toBe('github_issues')
    expect(() => customToolDefinitionSchema.parse({
      id: 'unsafe',
      name: 'Unsafe',
      description: 'Contains a credential.',
      urlTemplate: 'https://user:secret@example.com/data',
    })).toThrow(/credential/i)
  })

  it('accepts bounded structured nodes and rejects excessive depth, count, and text', () => {
    expect(parseStructuredResult({
      version: 1,
      nodes: [{ type: 'text', text: 'Summary', children: [{ type: 'text', text: 'Fact' }] }],
      sources: [{ url: 'https://example.com/article', label: 'Example' }],
    }).nodes).toHaveLength(1)

    let nested: unknown = { type: 'text', text: 'leaf' }
    for (let index = 0; index < 9; index += 1) nested = { type: 'text', text: 'node', children: [nested] }
    expect(() => parseStructuredResult({ version: 1, nodes: [nested], sources: [] })).toThrow(/depth/i)
    expect(() => parseStructuredResult({
      version: 1,
      nodes: Array.from({ length: 501 }, (_, index) => ({ type: 'text', text: `node ${index}` })),
      sources: [],
    })).toThrow(/node count/i)
    expect(() => parseStructuredResult({
      version: 1,
      nodes: [{ type: 'text', text: 'x'.repeat(20_001) }],
      sources: [],
    })).toThrow()
  })

  it('parses immutable run snapshots while rejecting secret-shaped fields', () => {
    const input = {
      version: 1,
      runId: 'run-1',
      executionMode: 'server',
      outlineId: 'outline-1',
      source: { nodeId: 'source-1', text: 'https://example.com', properties: { shareApp: 'shortcut' } },
      target: { parentId: 'source-1' },
      baseRevision: 12,
      configurationRevision: 3,
      credentialRef: 'credential-1',
      agent,
      skill,
      effectiveToolIds: ['web_fetch'],
      prompt: 'Research this capture.',
      context: ['Inbox', 'https://example.com'],
      customTools: [{
        id: 'github_issues', name: 'GitHub issues', description: 'Read public issues.',
        urlTemplate: 'https://api.github.com/repos/{{owner}}/{{repo}}/issues',
      }],
      outlineSnapshot: '{"nodes":[]}',
    }
    expect(runInputSchema.parse(input)).toEqual(input)
    expect(parseRunSnapshot(JSON.stringify(input)).runId).toBe('run-1')
    expect(() => parseRunSnapshot(JSON.stringify({ ...input, apiKey: 'sk-secret' }))).toThrow(/secret/i)
    expect(() => parseRunSnapshot(JSON.stringify({ ...input, source: { ...input.source, accessToken: 'secret' } }))).toThrow(/secret/i)
  })

  it('keeps activity payloads bounded and free of raw model reasoning', () => {
    expect(activityEventSchema.parse({
      id: 'event-1',
      sequence: 1,
      phase: 'complete',
      kind: 'tool',
      label: 'web_fetch',
      detail: 'Fetched example.com',
      status: 'success',
      durationMs: 10,
    }).sequence).toBe(1)
    expect(() => activityEventSchema.parse({
      id: 'event-1',
      sequence: 1,
      phase: 'complete',
      kind: 'reasoning',
      label: 'Chain of thought',
    })).toThrow()
  })
})
