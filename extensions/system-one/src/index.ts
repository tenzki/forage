import {
  defineExtension,
  type ExtensionSkillConfigurationForm,
  type ExtensionSkillExecutorDefinition,
} from '@forage/extension-api'
import { requireSystemOneConfiguration, validateSystemOneConfiguration } from './domain.js'
import { formatSystemOneResult } from './format.js'
import { prepareSystemOneInput, requirePreparedSystemOneData } from './preparation.js'
import { evaluateWithTypeSafe } from './transport.js'

export * from './domain.js'
export * from './format.js'
export * from './preparation.js'
export * from './transport.js'

export const systemOneConfigurationForm = {
  fields: [
    {
      key: 'model', label: 'Jev model',
      description: 'Aliases can move; the concrete model returned by TypeSafe is reported with each run.',
      type: 'choice',
      options: [
        { value: 'jev-latest', label: 'Jev latest' },
        { value: 'jev-preview', label: 'Jev preview' },
        { value: 'jev-1.13.0', label: 'Jev 1.13.0 (pinned)' },
      ],
      default: 'jev-latest', required: true,
    },
    {
      key: 'kind', label: 'Question type', type: 'choice',
      options: [
        { value: 'choice-comparison', label: 'Choice: compare candidates' },
        { value: 'choice-classification', label: 'Choice: classify candidates' },
        { value: 'score', label: 'Score candidates' },
        { value: 'noul', label: 'Noul: filter candidates' },
      ],
      default: 'score', required: true,
    },
    {
      key: 'question', label: 'Question',
      description: 'A complete explicit question. Candidate IDs are never used as inferred instructions.',
      type: 'multiline', required: true, minLength: 1, maxLength: 2_000,
    },
    {
      key: 'candidate_scope', label: 'Candidate scope', type: 'choice',
      options: [
        { value: 'siblings', label: 'Direct siblings with subtree evidence' },
        { value: 'descendants', label: 'All descendants of the parent branch' },
      ],
      default: 'siblings', required: true,
    },
    {
      key: 'ordering', label: 'Result order', type: 'choice',
      options: [
        { value: 'document', label: 'Document order' },
        { value: 'ascending', label: 'Numeric ascending' },
        { value: 'descending', label: 'Numeric descending' },
      ],
      default: 'document', required: true,
    },
    {
      key: 'decimal_places', label: 'Displayed decimal places', type: 'number', integer: true,
      minimum: 0, maximum: 6, default: 2, required: true,
    },
  ],
  branches: [
    {
      when: { field: 'kind', equals: 'choice-classification' },
      fields: [{
        key: 'categories', label: 'Categories',
        description: 'Unordered answer choices with explicit stable IDs and definitions.',
        type: 'repeat', minimumItems: 2, maximumItems: 50, required: true,
        fields: [
          { key: 'id', label: 'Category ID', type: 'text', required: true, minLength: 1, maxLength: 64 },
          { key: 'label', label: 'Label', type: 'text', required: true, minLength: 1, maxLength: 100 },
          { key: 'description', label: 'Definition', type: 'multiline', required: true, minLength: 1, maxLength: 1_000 },
        ],
      }],
    },
    {
      when: { field: 'kind', equals: 'score' },
      fields: [{
        key: 'levels', label: 'Ordered score levels',
        description: 'Two to ten explicit levels, from low to high.',
        type: 'repeat', minimumItems: 2, maximumItems: 10, required: true,
        fields: [
          { key: 'label', label: 'Level label', type: 'text', required: true, minLength: 1, maxLength: 100 },
          { key: 'description', label: 'Level definition', type: 'multiline', required: true, minLength: 1, maxLength: 1_000 },
        ],
      }],
    },
    {
      when: { field: 'kind', equals: 'noul' },
      fields: [
        { key: 'yes_definition', label: 'Yes definition', type: 'multiline', maxLength: 1_000 },
        { key: 'no_definition', label: 'No definition', type: 'multiline', maxLength: 1_000 },
        { key: 'threshold', label: 'Inclusive yes threshold', type: 'number', minimum: 0, maximum: 1, default: 0.5, required: true },
      ],
    },
  ],
} as const satisfies ExtensionSkillConfigurationForm

export interface SystemOneExecutorDependencies {
  fetch?: typeof fetch
}

export function createSystemOneExecutor(
  dependencies: SystemOneExecutorDependencies = {},
): ExtensionSkillExecutorDefinition {
  return {
    id: 'evaluate',
    name: 'System One',
    description: 'Compare, classify, score, or filter outline candidates with typed System One questions.',
    allowEmptyPrompt: true,
    configuration: systemOneConfigurationForm,
    async validateConfiguration({ configuration }, context) {
      context.signal.throwIfAborted()
      return validateSystemOneConfiguration(configuration)
    },
    async prepare({ configuration, context }, operation) {
      operation.signal.throwIfAborted()
      const parsed = requireSystemOneConfiguration(configuration)
      const plan = prepareSystemOneInput(parsed, context)
      operation.reportProgress({
        message: `Prepared ${plan.selectedNodeIds.length} System One candidate${plan.selectedNodeIds.length === 1 ? '' : 's'}`,
        completed: 1,
        total: 1,
      })
      return plan
    },
    async execute(input, operation) {
      operation.signal.throwIfAborted()
      const configuration = requireSystemOneConfiguration(input.configuration)
      const prepared = requirePreparedSystemOneData(input.plan.data)
      const candidateIds = prepared.candidates.map((candidate) => candidate.id)
      assertSameIds(input.plan.selectedNodeIds, candidateIds, 'selected candidates')
      assertSameIds(input.plan.admittedReferenceIds, candidateIds, 'admitted candidate references')
      const evaluation = await evaluateWithTypeSafe({
        configuration,
        prepared,
        prompt: input.context.prompt,
        apiKey: operation.secrets.typesafe_api_key,
        signal: operation.signal,
        ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
        reportProgress: operation.reportProgress,
      })
      operation.log({
        level: 'info',
        message: `System One evaluation completed with ${evaluation.actualModel}.`,
        data: {
          provider: 'TypeSafe',
          requestedModel: evaluation.requestedModel,
          actualModel: evaluation.actualModel,
          inputTokens: evaluation.usage.inputTokens,
          outputTokens: evaluation.usage.outputTokens,
        },
      })
      operation.signal.throwIfAborted()
      return formatSystemOneResult(configuration, prepared, evaluation)
    },
  }
}

export const systemOneExecutor = createSystemOneExecutor()

export default defineExtension((forage) => {
  forage.registerSkillExecutor(systemOneExecutor)
})

function assertSameIds(actual: readonly string[], expected: readonly string[], label: string): void {
  if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) {
    throw new Error(`System One admitted plan ${label} do not match its prepared data.`)
  }
}
