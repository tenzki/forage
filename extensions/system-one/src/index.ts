import {
  defineExtension,
  type ExtensionSkillConfigurationForm,
  type ExtensionSkillExecutorDefinition,
} from '@forage/extension-api'
import { requireSystemOneConfiguration, resolveSystemOneQuestion, validateSystemOneConfiguration } from './domain.js'
import { describeSystemOneRow, formatSystemOneResult, systemOneResultRows } from './format.js'
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
      key: 'question', label: 'Default question',
      description: 'Used when the command is run without typed text; typed text after the command replaces it.',
      type: 'multiline', required: false, maxLength: 2_000,
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
      key: 'output', label: 'Output',
      description: 'Reordering moves the sibling bullets into the result order (highest first, or by category). Tagging adds each bullet\'s category tag (classification) or the yes tag (Noul) to its text. Neither writes new bullets.',
      type: 'choice',
      options: [
        { value: 'list', label: 'List results under the question' },
        { value: 'reorder', label: 'Reorder the bullets in place' },
        { value: 'tag', label: 'Tag the bullets in place' },
      ],
      default: 'list', required: false,
    },
  ],
  branches: [
    {
      when: { field: 'kind', equals: 'choice-classification' },
      fields: [{
        key: 'categories', label: 'Categories',
        description: 'Answer choices with definitions. Results are grouped in this order.',
        type: 'repeat', minimumItems: 2, maximumItems: 50, required: true,
        fields: [
          { key: 'label', label: 'Label', type: 'text', required: true, minLength: 1, maxLength: 100 },
          { key: 'description', label: 'Definition', type: 'multiline', required: true, minLength: 1, maxLength: 1_000 },
          {
            key: 'tag', label: 'Tag',
            description: 'Used by tag output. Defaults to the label, e.g. "Build later" becomes #build-later.',
            type: 'text', required: false, maxLength: 65,
          },
        ],
      }, {
        key: 'minimum_probability', label: 'Minimum probability',
        description: 'Bullets whose chosen category falls below this are left unclassified: listed under Unclassified, moved last when reordering, and left untagged.',
        type: 'number', minimum: 0, maximum: 1, required: false,
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
        {
          key: 'tag', label: 'Tag',
          description: 'Required by tag output. Added to bullets at or above the threshold and removed from the rest.',
          type: 'text', required: false, maxLength: 65,
        },
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
      // Fail before any paid request when neither typed text nor a default supplies the question.
      resolveSystemOneQuestion(parsed, context.prompt)
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
      // In-place output writes no bullets, so each candidate's answer is reported in run activity instead.
      if (configuration.output !== 'list') {
        for (const row of systemOneResultRows(configuration, prepared, evaluation)) {
          operation.log({ level: 'info', message: describeSystemOneRow(row) })
        }
      }
      return formatSystemOneResult(configuration, prepared, evaluation, input.context.prompt)
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
