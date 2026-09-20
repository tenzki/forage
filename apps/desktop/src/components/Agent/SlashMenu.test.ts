import { describe, expect, it } from 'vitest'
import type { ExtensionCatalog } from '@forage/agent-runtime'
import type { SkillDefinition } from '../../agent/definitions'
import { skillAllowsEmptyPrompt, skillInvocationPrompt } from './SlashMenu'

const llm: SkillDefinition = {
  id: 'ask', execution: 'llm', label: 'ask', description: 'Ask', agentId: 'agent',
  systemPrompt: 'Answer.', requiredToolIds: [],
}
const extension: SkillDefinition = {
  id: 'label', execution: 'extension', label: 'label', description: 'Label notes',
  executor: { extensionId: 'dev.example.notes', executorId: 'label_notes' }, configuration: { prefix: 'Match' },
}
const catalog: ExtensionCatalog = {
  version: 1, revision: 'a'.repeat(64), entries: [{
    source: { kind: 'local', installationId: 'notes', requestedPath: '/notes', canonicalPath: '/notes' },
    manifest: {
      id: 'dev.example.notes', name: 'Notes', version: '1.0.0', description: 'Notes executor.', entry: './index.js',
      contributes: { tools: [], hooks: [], settings: [], executors: [{
        id: 'label_notes', name: 'Label notes', description: 'Label notes.', allowEmptyPrompt: true, configuration: { fields: [] },
      }] },
    },
    provenance: { installationId: 'notes', extensionId: 'dev.example.notes', sourceKind: 'local', sourceRevision: 'one', entryDigest: 'b'.repeat(64) },
    status: 'ready', tools: [], executors: [{
      id: 'label_notes', name: 'Label notes', description: 'Label notes.', allowEmptyPrompt: true,
      configuration: { fields: [] }, available: true, diagnostics: [],
    }], diagnostics: [],
  }],
}

describe('slash skill invocation routing', () => {
  it('uses the selected executor declaration for empty-prompt policy', () => {
    expect(skillAllowsEmptyPrompt(extension, catalog)).toBe(true)
    expect(skillAllowsEmptyPrompt(extension, null)).toBe(false)
    expect(skillInvocationPrompt(extension, '')).toBe('')
    expect(skillInvocationPrompt(extension, ' extra constraint ')).toBe('extra constraint')
  })

  it('retains the existing LLM fallback prompt behavior', () => {
    expect(skillAllowsEmptyPrompt(llm)).toBe(false)
    expect(skillInvocationPrompt(llm, '')).toBe('ask')
  })
})
