import type { ExtensionSkillResult, ExtensionSkillResultNode } from '@forage/extension-api'
import type { SystemOneConfiguration } from './domain.js'
import type { PreparedCandidate, PreparedSystemOneData } from './preparation.js'
import {
  optionKey,
  questionKey,
  type ChoiceAnswer,
  type NoulAnswer,
  type ScoreAnswer,
  type SystemOneEvaluation,
} from './transport.js'

export interface CandidateRow {
  candidate: PreparedCandidate
  metric: number
  detail: string
}

/** Rows in result order. Reordering keeps every Noul candidate, so nothing is left out of place. */
export function systemOneResultRows(
  configuration: SystemOneConfiguration,
  prepared: PreparedSystemOneData,
  evaluation: SystemOneEvaluation,
): CandidateRow[] {
  const rows = configuration.kind === 'choice-comparison'
    ? comparisonRows(configuration, prepared, evaluation)
    : configuration.kind === 'choice-classification'
      ? classificationRows(configuration, prepared, evaluation)
      : configuration.kind === 'score'
        ? scoreRows(configuration, prepared, evaluation)
        : noulRows(configuration, prepared, evaluation, configuration.output !== 'reorder')
  return sortRows(rows, configuration.ordering)
}

export function formatSystemOneResult(
  configuration: SystemOneConfiguration,
  prepared: PreparedSystemOneData,
  evaluation: SystemOneEvaluation,
): ExtensionSkillResult {
  const ordered = systemOneResultRows(configuration, prepared, evaluation)
  if (configuration.output === 'reorder') {
    return { nodes: [], reorder: { nodeIds: ordered.map((row) => row.candidate.id) } }
  }
  const resultRows = ordered.map(linkedRow)
  const children = configuration.kind === 'noul' && resultRows.length === 0
    ? [textNode(`No matches met the inclusive yes-probability threshold of ${formatProbability(configuration.threshold, configuration.decimalPlaces)}.`)]
    : resultRows
  // A single question root lets Forage replace an empty invocation bullet with it.
  return {
    nodes: [{
      type: 'text',
      segments: [{ type: 'text', text: configuration.question }],
      children,
    }],
  }
}

function comparisonRows(
  configuration: Extract<SystemOneConfiguration, { kind: 'choice-comparison' }>,
  prepared: PreparedSystemOneData,
  evaluation: SystemOneEvaluation,
): CandidateRow[] {
  const answer = requireChoice(evaluation.answers.get('comparison'), 'comparison')
  return prepared.candidates.map((candidate, index) => {
    const key = optionKey(index)
    const probability = answer.probabilities[key]
    if (probability === undefined) throw new Error(`System One Choice answer is missing ${key}.`)
    return {
      candidate,
      metric: probability,
      detail: `Probability: ${formatProbability(probability, configuration.decimalPlaces)}; selected: ${answer.choice === key ? 'yes' : 'no'}; confidence: ${formatProbability(answer.confidence, configuration.decimalPlaces)}`,
    }
  })
}

function classificationRows(
  configuration: Extract<SystemOneConfiguration, { kind: 'choice-classification' }>,
  prepared: PreparedSystemOneData,
  evaluation: SystemOneEvaluation,
): CandidateRow[] {
  const categories = new Map(configuration.categories.map((category) => [category.id, category]))
  return prepared.candidates.map((candidate, index) => {
    const answer = requireChoice(evaluation.answers.get(questionKey(index)), questionKey(index))
    const category = categories.get(answer.choice)
    const probability = answer.probabilities[answer.choice]
    if (!category || probability === undefined) throw new Error('System One Choice classification returned an unknown category.')
    return {
      candidate,
      metric: probability,
      detail: `Category: ${category.label}; probability: ${formatProbability(probability, configuration.decimalPlaces)}; confidence: ${formatProbability(answer.confidence, configuration.decimalPlaces)}`,
    }
  })
}

function scoreRows(
  configuration: Extract<SystemOneConfiguration, { kind: 'score' }>,
  prepared: PreparedSystemOneData,
  evaluation: SystemOneEvaluation,
): CandidateRow[] {
  return prepared.candidates.map((candidate, index) => {
    const answer = requireScore(evaluation.answers.get(questionKey(index)), questionKey(index))
    const level = configuration.levels[Math.min(configuration.levels.length - 1, Math.max(0, Math.round(answer.score)))]
    return {
      candidate,
      metric: answer.score,
      detail: `${level?.label ?? 'Unknown level'} (${answer.score.toFixed(configuration.decimalPlaces)}); confidence: ${formatProbability(answer.confidence, configuration.decimalPlaces)}`,
    }
  })
}

function noulRows(
  configuration: Extract<SystemOneConfiguration, { kind: 'noul' }>,
  prepared: PreparedSystemOneData,
  evaluation: SystemOneEvaluation,
  applyThreshold: boolean,
): CandidateRow[] {
  return prepared.candidates.flatMap((candidate, index): CandidateRow[] => {
    const answer = requireNoul(evaluation.answers.get(questionKey(index)), questionKey(index))
    if (applyThreshold && answer.noul < configuration.threshold) return []
    return [{
      candidate,
      metric: answer.noul,
      detail: `Yes probability: ${formatProbability(answer.noul, configuration.decimalPlaces)}`,
    }]
  })
}

function sortRows(rows: readonly CandidateRow[], ordering: SystemOneConfiguration['ordering']): CandidateRow[] {
  return [...rows].sort((left, right) => {
    if (ordering === 'ascending' && left.metric !== right.metric) return left.metric - right.metric
    if (ordering === 'descending' && left.metric !== right.metric) return right.metric - left.metric
    return left.candidate.documentOrder - right.candidate.documentOrder
  })
}

function linkedRow(row: CandidateRow): ExtensionSkillResultNode {
  return {
    type: 'text',
    segments: [
      { type: 'internal-reference', nodeId: row.candidate.id, label: boundedReferenceLabel(row.candidate.label) },
      { type: 'text', text: ` - ${row.detail}` },
    ],
  }
}

function textNode(text: string): ExtensionSkillResultNode {
  return { type: 'text', segments: [{ type: 'text', text }] }
}

function boundedReferenceLabel(label: string): string {
  return label.trim().slice(0, 500) || 'Untitled note'
}

function formatProbability(value: number, decimalPlaces: number): string {
  return `${(value * 100).toFixed(decimalPlaces)}%`
}

function requireChoice(value: unknown, id: string): ChoiceAnswer {
  if (!value || typeof value !== 'object' || !('type' in value) || value.type !== 'choice') {
    throw new Error(`System One is missing the Choice answer for ${id}.`)
  }
  return value as ChoiceAnswer
}

function requireScore(value: unknown, id: string): ScoreAnswer {
  if (!value || typeof value !== 'object' || !('type' in value) || value.type !== 'score') {
    throw new Error(`System One is missing the Score answer for ${id}.`)
  }
  return value as ScoreAnswer
}

function requireNoul(value: unknown, id: string): NoulAnswer {
  if (!value || typeof value !== 'object' || !('type' in value) || value.type !== 'noul') {
    throw new Error(`System One is missing the Noul answer for ${id}.`)
  }
  return value as NoulAnswer
}
