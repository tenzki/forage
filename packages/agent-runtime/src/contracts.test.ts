import { describe, expect, it } from 'vitest'
import {
  activityEventSchema,
  admitExtensionSkillPreparedPlan,
  agentConfigurationSchema,
  agentDefinitionSchema,
  customToolDefinitionSchema,
  extensionSkillDefinitionSchema,
  extensionSkillRunInputSchema,
  migrateAgentConfiguration,
  parseRunSnapshot,
  parseStructuredResult,
  portableAgentConfigurationV2Schema,
  portableAgentConfigurationSchema,
  runInputSchema,
  skillDefinitionSchema,
} from './contracts'

const agent = {
  id: 'research-agent', name: 'Research agent', description: 'Finds sources.',
  systemPrompt: 'Research the supplied material.', modelId: 'gpt-5', toolIds: ['web_fetch'],
}
const legacySkill = {
  id: 'research', label: 'research', description: 'Research a URL.',
  systemPrompt: 'Return notes.', agentId: agent.id, requiredToolIds: ['web_fetch'],
}
const llmSkill = { ...legacySkill, execution: 'llm' as const }
const extensionSkill = {
  id: 'summarize-notes', label: 'summarize-notes', description: 'Summarize selected notes.',
  execution: 'extension' as const,
  executor: { extensionId: 'dev.example.notes', executorId: 'summarize' },
  configuration: { heading: 'Key notes', maximum: 5, includeLabels: true },
}
const context = {
  prompt: '',
  invocation: { id: 'invocation', text: '/summarize-notes', parentId: 'parent', documentOrder: 4 },
  roots: [{ id: 'root', text: 'Project', documentOrder: 0, children: [
    { id: 'parent', text: 'Ideas', documentOrder: 1, children: [
      { id: 'one', text: 'First', documentOrder: 2 },
      { id: 'two', text: 'Second', documentOrder: 3 },
    ] },
    { id: 'linked', text: 'Constraints', documentOrder: 5 },
  ] }],
  provenance: {
    ancestorPathIds: ['root', 'parent'], localParentId: 'parent', localBranchRootId: 'root',
    explicitLinkedRootIds: ['linked'],
  },
}
const prepared = {
  selectedNodeIds: ['one', 'two'], requestedReferenceIds: ['one', 'two'],
  annotations: [
    { nodeId: 'one', kind: 'selected' as const, label: 'Input' },
    { nodeId: 'linked', kind: 'shared' as const, label: 'Shared constraints' },
  ],
  data: { format: 'brief' },
}

describe('agent runtime contracts', () => {
  it('parses strict LLM and generic extension-backed definitions', () => {
    expect(agentDefinitionSchema.parse(agent)).toEqual(agent)
    expect(skillDefinitionSchema.parse(llmSkill)).toEqual(llmSkill)
    expect(extensionSkillDefinitionSchema.parse(extensionSkill)).toEqual(extensionSkill)
    expect(() => extensionSkillDefinitionSchema.parse({ ...extensionSkill, configuration: { apiKey: 'secret' } })).toThrow(/secret/i)
    expect(() => extensionSkillDefinitionSchema.parse({ ...extensionSkill, configuration: { nested: { access_token: 'secret' } } })).toThrow(/secret/i)
    expect(() => extensionSkillDefinitionSchema.parse({ ...extensionSkill, configuration: { canonicalPath: '/tmp/extension' } })).toThrow(/path/i)
    expect(() => extensionSkillDefinitionSchema.parse({ ...extensionSkill, configuration: { nested: { trustStatus: 'trusted' } } })).toThrow(/trust/i)
    expect(() => skillDefinitionSchema.parse({ ...llmSkill, label: 'Not valid!' })).toThrow()
  })

  it('retains unavailable executor references and bounded uninterpreted configuration', () => {
    const configuration = portableAgentConfigurationSchema.parse({
      version: 3, revision: 41, agents: [], skills: [extensionSkill], customTools: [], globallyEnabledToolIds: [],
    })
    expect(portableAgentConfigurationSchema.parse(JSON.parse(JSON.stringify(configuration)))).toEqual(configuration)
    expect(() => extensionSkillDefinitionSchema.parse({
      ...extensionSkill, configuration: { values: Array.from({ length: 1_001 }, () => true) },
    })).toThrow()
  })

  it('migrates historical configuration to LLM skills without semantic drift', () => {
    const version1 = agentConfigurationSchema.parse({
      version: 1, revision: 7, agents: [{ ...agent, credentialRef: 'credential-1' }],
      skills: [legacySkill], customTools: [], globallyEnabledToolIds: ['web_fetch'],
    })
    const version2 = portableAgentConfigurationV2Schema.parse({
      version: 2, revision: 8,
      agents: [{ id: agent.id, name: agent.name, description: agent.description, systemPrompt: agent.systemPrompt, toolIds: agent.toolIds }],
      skills: [legacySkill], customTools: [], globallyEnabledToolIds: ['web_fetch'],
    })
    expect(migrateAgentConfiguration(version1).configuration.skills).toEqual([llmSkill])
    expect(migrateAgentConfiguration(version2).configuration.skills).toEqual([llmSkill])
  })

  it('keeps existing LLM run snapshots and secret rejection intact', () => {
    const input = {
      version: 1 as const, runId: 'run-1', executionMode: 'server' as const, outlineId: 'outline-1',
      source: { nodeId: 'source-1' }, target: { parentId: 'source-1' }, baseRevision: 1,
      configurationRevision: 3, credentialRef: 'credential-1', agent, skill: legacySkill,
      effectiveToolIds: ['web_fetch'], prompt: 'Research this.', context: ['Inbox'],
    }
    expect(runInputSchema.parse(input)).toEqual(input)
    expect(parseRunSnapshot(JSON.stringify(input))).toEqual(input)
    expect(() => parseRunSnapshot(JSON.stringify({ ...input, accessToken: 'secret' }))).toThrow(/secret/i)
  })

  it('validates and pins host-confined plans without accepting a self-authorized reference', () => {
    expect(admitExtensionSkillPreparedPlan(prepared, context, ['one', 'two'])).toEqual({
      ...prepared, admittedReferenceIds: ['one', 'two'],
    })
    expect(() => admitExtensionSkillPreparedPlan({
      ...prepared, selectedNodeIds: ['outside'],
    }, context, ['one', 'two'])).toThrow(/outside the host context/i)
    expect(() => admitExtensionSkillPreparedPlan({
      ...prepared, requestedReferenceIds: ['linked'],
    }, context, ['one', 'two'])).toThrow(/not admitted by the host/i)
  })

  it('enforces unique context serialization, provenance, and the 100-node/40k budget including prompt', () => {
    const hundred = Array.from({ length: 100 }, (_, index) => ({
      id: `node-${index}`, documentOrder: index, text: index < 2 ? 'x'.repeat(19_999) : '',
    }))
    const boundary = {
      prompt: 'xx', invocation: { id: 'invocation', text: '', documentOrder: 100 }, roots: hundred,
      provenance: { ancestorPathIds: [], explicitLinkedRootIds: [] },
    }
    const plan = { selectedNodeIds: [], requestedReferenceIds: [], annotations: [], data: {} }
    expect(admitExtensionSkillPreparedPlan(plan, boundary, [])).toBeDefined()
    expect(() => admitExtensionSkillPreparedPlan(plan, { ...boundary, prompt: 'xxx' }, [])).toThrow(/40000 characters/i)
    expect(() => admitExtensionSkillPreparedPlan(plan, {
      ...boundary, roots: [...hundred, { id: 'node-100', text: '', documentOrder: 101 }],
    }, [])).toThrow(/100 nodes/i)
    expect(() => admitExtensionSkillPreparedPlan(plan, {
      ...context, roots: [...context.roots, { id: 'one', text: 'duplicate', documentOrder: 9 }],
    }, [])).toThrow(/unique/i)
    expect(() => admitExtensionSkillPreparedPlan(plan, {
      ...context, provenance: { ...context.provenance, explicitLinkedRootIds: ['missing'] },
    }, [])).toThrow(/unknown node/i)
  })

  it('keeps portable and device-local configuration revisions independent in admitted runs', () => {
    const plan = admitExtensionSkillPreparedPlan(prepared, context, ['one', 'two'])
    const input = {
      version: 2 as const, execution: 'extension' as const, runId: 'run-extension', executionMode: 'local' as const,
      outlineId: 'outline', source: { nodeId: 'invocation' }, target: { parentId: 'invocation' }, baseRevision: 1,
      configurationRevision: 42,
      authority: { type: 'local-extension-executor' as const, executor: extensionSkill.executor },
      localExecutorSnapshot: {
        version: 1 as const, catalogRevision: 'a'.repeat(64), configurationRevision: 7,
        source: { installationId: 'notes-installation', extensionId: 'dev.example.notes', sourceRevision: 'b'.repeat(64), entryDigest: 'c'.repeat(64), executorId: 'summarize' },
      },
      skill: extensionSkill, context, plan,
    }
    expect(extensionSkillRunInputSchema.parse(input)).toEqual(input)
    expect(parseRunSnapshot(JSON.stringify(input))).toEqual(input)
    expect(() => extensionSkillRunInputSchema.parse({ ...input, executionMode: 'server' })).toThrow()
    expect(() => extensionSkillRunInputSchema.parse({
      ...input, authority: { ...input.authority, executor: { ...input.authority.executor, executorId: 'other' } },
    })).toThrow(/authority/i)
  })

  it('accepts a sibling reorder of admitted nodes in place of new bullets', () => {
    const result = { version: 2 as const, nodes: [], sources: [], reorder: { nodeIds: ['two', 'one'] } }
    expect(parseStructuredResult(result, { allowedReferenceIds: ['one', 'two'] })).toEqual(result)
    expect(() => parseStructuredResult(result, { allowedReferenceIds: ['one'] })).toThrow(/unadmitted node/i)
    expect(() => parseStructuredResult({ ...result, reorder: undefined })).toThrow(/nodes or a reorder/i)
    expect(() => parseStructuredResult({ ...result, reorder: { nodeIds: ['one', 'one'] } })).toThrow(/unique/i)
  })

  it('validates generic linked results against host authority and aggregate text limits', () => {
    const result = {
      version: 2 as const,
      nodes: [{ type: 'text' as const, segments: [
        { type: 'internal-reference' as const, nodeId: 'one', label: 'First note' },
        { type: 'text' as const, text: ' — summary' },
      ] }],
      sources: [],
    }
    expect(parseStructuredResult(result, { allowedReferenceIds: ['one'] })).toEqual(result)
    expect(() => parseStructuredResult(result, { allowedReferenceIds: ['two'] })).toThrow(/unadmitted reference/i)
    expect(() => parseStructuredResult({
      ...result, nodes: Array.from({ length: 6 }, () => ({ type: 'text', segments: [{ type: 'text', text: 'x'.repeat(20_000) }] })),
    }, { allowedReferenceIds: [] })).toThrow(/maximum text size/i)
    expect(parseStructuredResult({ version: 1, nodes: [{ type: 'text', text: 'Historical' }], sources: [] }).version).toBe(1)
  })

  it('keeps existing bounded helper contracts', () => {
    expect(customToolDefinitionSchema.parse({
      id: 'issues', name: 'Issues', description: 'Read issues.', urlTemplate: 'https://example.com/{{id}}',
    }).id).toBe('issues')
    expect(activityEventSchema.parse({ id: 'event-1', sequence: 1, phase: 'complete', kind: 'status', label: 'Done' }).sequence).toBe(1)
  })
})
