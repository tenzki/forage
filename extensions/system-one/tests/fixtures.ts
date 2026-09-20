import type {
  ExtensionJsonObject,
  ExtensionSkillAdmittedPlan,
  ExtensionSkillContextSnapshot,
} from '@forage/extension-api'
import type { PreparedSystemOneData, SystemOneConfiguration, SystemOneEvaluation } from '../src/index.js'

export const baseConfiguration: ExtensionJsonObject = {
  model: 'jev-latest',
  kind: 'score',
  question: 'How promising is this idea?',
  candidate_scope: 'siblings',
  ordering: 'document',
  decimal_places: 2,
  levels: [
    { label: 'Weak', description: 'Unclear value or feasibility.' },
    { label: 'Strong', description: 'Clear value and credible feasibility.' },
  ],
}

export const contextSnapshot: ExtensionSkillContextSnapshot = {
  prompt: 'Prefer ideas that can ship this quarter.',
  invocation: { id: 'invoke', text: '/evaluate', parentId: 'parent', documentOrder: 6 },
  roots: [
    {
      id: 'root', text: 'Product planning', documentOrder: 0, children: [{
        id: 'parent', text: 'Ideas', documentOrder: 1, children: [
          {
            id: 'idea-a', text: 'Offline capture', documentOrder: 2,
            children: [{ id: 'evidence-a', text: 'Users travel frequently', documentOrder: 3 }],
          },
          { id: 'idea-b', text: 'Keyboard navigation', documentOrder: 4 },
          { id: 'empty', text: '   ', documentOrder: 5 },
        ],
      }],
    },
    {
      id: 'constraints', text: 'Constraints', documentOrder: 7,
      children: [{ id: 'constraint-one', text: 'Must work locally', documentOrder: 8 }],
    },
  ],
  provenance: {
    ancestorPathIds: ['root', 'parent'],
    localParentId: 'parent',
    localBranchRootId: 'root',
    explicitLinkedRootIds: ['constraints'],
  },
}

export const preparedData: PreparedSystemOneData = {
  version: 1,
  candidateScope: 'siblings',
  candidates: [
    {
      id: 'idea-a', label: 'Offline capture', text: 'Offline capture', documentOrder: 2,
      evidence: [{ id: 'evidence-a', text: 'Users travel frequently', documentOrder: 3 }],
    },
    { id: 'idea-b', label: 'Keyboard navigation', text: 'Keyboard navigation', documentOrder: 4, evidence: [] },
  ],
  sharedEvidence: [
    { id: 'root', text: 'Product planning', documentOrder: 0, provenance: 'ancestor' },
    { id: 'parent', text: 'Ideas', documentOrder: 1, provenance: 'ancestor' },
    { id: 'constraints', text: 'Constraints', documentOrder: 7, provenance: 'explicit-link' },
    { id: 'constraint-one', text: 'Must work locally', documentOrder: 8, provenance: 'explicit-link' },
  ],
}

export const admittedPlan: ExtensionSkillAdmittedPlan = {
  selectedNodeIds: ['idea-a', 'idea-b'],
  requestedReferenceIds: ['idea-a', 'idea-b'],
  admittedReferenceIds: ['idea-a', 'idea-b'],
  annotations: [],
  data: JSON.parse(JSON.stringify(preparedData)) as ExtensionJsonObject,
}

export function scoreConfiguration(overrides: Partial<SystemOneConfiguration> = {}): SystemOneConfiguration {
  return {
    model: 'jev-latest', kind: 'score', question: 'How promising is this idea?', candidateScope: 'siblings',
    ordering: 'document', decimalPlaces: 2,
    levels: [
      { label: 'Weak', description: 'Unclear value or feasibility.' },
      { label: 'Strong', description: 'Clear value and credible feasibility.' },
    ],
    ...overrides,
  } as SystemOneConfiguration
}

export function evaluation(answers: ReadonlyMap<string, SystemOneEvaluation['answers'] extends ReadonlyMap<string, infer A> ? A : never>): SystemOneEvaluation {
  return {
    requestedModel: 'jev-latest',
    actualModel: 'jev-1.13.0',
    answers,
    usage: { inputTokens: 100, outputTokens: 10 },
  }
}
