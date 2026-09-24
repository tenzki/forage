import type { ExtensionSkillResult, ExtensionSkillResultNode } from '@forage/extension-api'
import { resolveSystemOneQuestion, type SystemOneConfiguration } from './domain.js'
import type { PreparedCandidate, PreparedSystemOneData } from './preparation.js'
import {
  categoryKey,
  optionKey,
  questionKey,
  type ChoiceAnswer,
  type NoulAnswer,
  type ScoreAnswer,
  type SystemOneEvaluation,
} from './transport.js'

export interface CandidateRow {
  candidate: PreparedCandidate
  /** Sort key; higher values come first. */
  metric: number
  /** Classification category, in configured order. */
  category?: { index: number; label: string }
  /** Classification below the minimum probability: grouped, sorted and tagged as unclassified. */
  uncertain?: boolean
  /** Short value shown after the candidate link. */
  value?: string
  /** Numeric detail written to the result bullet's note. */
  note: string
}

/**
 * Rows in result order. Reordering and tagging keep every Noul candidate, so
 * nothing is left out of place and stale tags can be cleared.
 */
export function systemOneResultRows(
  configuration: SystemOneConfiguration,
  prepared: PreparedSystemOneData,
  evaluation: SystemOneEvaluation,
): CandidateRow[] {
  const rows = configuration.kind === 'choice-comparison'
    ? comparisonRows(prepared, evaluation)
    : configuration.kind === 'choice-classification'
      ? classificationRows(configuration, prepared, evaluation)
      : configuration.kind === 'score'
        ? scoreRows(configuration, prepared, evaluation)
        : noulRows(configuration, prepared, evaluation, configuration.output === 'list')
  return sortRows(rows)
}

/** One line per candidate for run activity, where in-place output reports its answers. */
export function describeSystemOneRow(row: CandidateRow): string {
  const value = row.uncertain ? `unclassified, best guess ${row.value}` : row.category?.label ?? row.value
  return `${row.candidate.label.slice(0, 200)}${value ? ` - ${value}` : ''} (${row.note})`
}

export function formatSystemOneResult(
  configuration: SystemOneConfiguration,
  prepared: PreparedSystemOneData,
  evaluation: SystemOneEvaluation,
  prompt: string,
): ExtensionSkillResult {
  const ordered = systemOneResultRows(configuration, prepared, evaluation)
  if (configuration.output === 'reorder') {
    return { nodes: [], reorder: { nodeIds: ordered.map((row) => row.candidate.id) } }
  }
  if (configuration.output === 'tag') return { nodes: [], tags: tagEdits(configuration, ordered) }
  const results = configuration.kind === 'choice-classification'
    ? classificationGroups(configuration, ordered)
    : ordered.map(linkedRow)
  const nodes = configuration.kind === 'noul' && results.length === 0
    ? [textNode(`No matches reached the yes threshold of ${percent(configuration.threshold)}.`)]
    : results
  // Typed text stays in the invocation bullet as the question, so results sit directly under it.
  if (prompt.trim()) return { nodes }
  // A single question root lets Forage replace an empty invocation bullet with it.
  return {
    nodes: [{
      type: 'text',
      segments: [{ type: 'text', text: resolveSystemOneQuestion(configuration, prompt) }],
      children: nodes,
    }],
  }
}

/** Category groups in configured order, then uncertain rows; empty groups are omitted. */
function classificationGroups(
  configuration: Extract<SystemOneConfiguration, { kind: 'choice-classification' }>,
  rows: readonly CandidateRow[],
): ExtensionSkillResultNode[] {
  const groups = configuration.categories.map((category, index) => ({
    label: category.label,
    members: rows.filter((row) => !row.uncertain && row.category?.index === index),
  }))
  groups.push({ label: 'Unclassified', members: rows.filter((row) => row.uncertain) })
  return groups.flatMap((group) => group.members.length
    ? [{ ...textNode(group.label), children: group.members.map(linkedRow) }]
    : [])
}

/**
 * Each candidate gets at most one tag from this skill's vocabulary; the rest of
 * the vocabulary is removed so a rerun replaces the previous answer.
 */
function tagEdits(
  configuration: SystemOneConfiguration,
  rows: readonly CandidateRow[],
): NonNullable<ExtensionSkillResult['tags']> {
  if (configuration.kind === 'choice-classification') {
    const vocabulary = configuration.categories.flatMap((category) => category.tag ? [category.tag] : [])
    return rows.map((row) => {
      const tag = row.category && !row.uncertain ? configuration.categories[row.category.index]?.tag : undefined
      return { nodeId: row.candidate.id, add: tag ? [tag] : [], remove: vocabulary.filter((entry) => entry !== tag) }
    })
  }
  if (configuration.kind === 'noul' && configuration.tag) {
    const tag = configuration.tag
    return rows.map((row) => row.metric >= configuration.threshold
      ? { nodeId: row.candidate.id, add: [tag] }
      : { nodeId: row.candidate.id, add: [], remove: [tag] })
  }
  throw new Error('System One tag output requires Choice classification or a Noul tag.')
}

function comparisonRows(
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
      ...(answer.choice === key ? { value: '★' } : {}),
      note: `Probability ${percent(probability)} · confidence ${percent(answer.confidence)}`,
    }
  })
}

function classificationRows(
  configuration: Extract<SystemOneConfiguration, { kind: 'choice-classification' }>,
  prepared: PreparedSystemOneData,
  evaluation: SystemOneEvaluation,
): CandidateRow[] {
  return prepared.candidates.map((candidate, index) => {
    const answer = requireChoice(evaluation.answers.get(questionKey(index)), questionKey(index))
    const categoryIndex = configuration.categories.findIndex((_, position) => categoryKey(position) === answer.choice)
    const category = configuration.categories[categoryIndex]
    const probability = answer.probabilities[answer.choice]
    if (!category || probability === undefined) throw new Error('System One Choice classification returned an unknown category.')
    const uncertain = probability < (configuration.minimumProbability ?? 0)
    return {
      candidate,
      metric: probability,
      category: { index: categoryIndex, label: category.label },
      // Uncertain rows sit under Unclassified, so their best guess is shown on the line.
      ...(uncertain ? { uncertain, value: category.label } : {}),
      note: `Probability ${percent(probability)} · confidence ${percent(answer.confidence)}`,
    }
  })
}

function scoreRows(
  configuration: Extract<SystemOneConfiguration, { kind: 'score' }>,
  prepared: PreparedSystemOneData,
  evaluation: SystemOneEvaluation,
): CandidateRow[] {
  const top = configuration.levels.length - 1
  return prepared.candidates.map((candidate, index) => {
    const answer = requireScore(evaluation.answers.get(questionKey(index)), questionKey(index))
    const level = configuration.levels[Math.min(top, Math.max(0, Math.round(answer.score)))]
    return {
      candidate,
      metric: answer.score,
      value: level?.label ?? 'Unknown level',
      note: `Score ${answer.score.toFixed(2)} of ${top} · confidence ${percent(answer.confidence)}`,
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
    return [{ candidate, metric: answer.noul, note: `Yes probability ${percent(answer.noul)}` }]
  })
}

/**
 * Classification keeps configured category order with uncertain rows last;
 * every other kind puts the highest value first.
 */
function sortRows(rows: readonly CandidateRow[]): CandidateRow[] {
  const group = (row: CandidateRow) => row.uncertain ? Number.POSITIVE_INFINITY : row.category!.index
  return [...rows].sort((left, right) => {
    if (left.category && right.category && group(left) !== group(right)) return group(left) - group(right)
    if (!left.category && left.metric !== right.metric) return right.metric - left.metric
    return left.candidate.documentOrder - right.candidate.documentOrder
  })
}

function linkedRow(row: CandidateRow): ExtensionSkillResultNode {
  return {
    type: 'text',
    segments: [
      { type: 'internal-reference', nodeId: row.candidate.id, label: boundedReferenceLabel(row.candidate.label) },
      ...(row.value ? [{ type: 'text' as const, text: ` ${row.value}` }] : []),
    ],
    note: row.note,
  }
}

function textNode(text: string): ExtensionSkillResultNode {
  return { type: 'text', segments: [{ type: 'text', text }] }
}

function boundedReferenceLabel(label: string): string {
  return label.trim().slice(0, 500) || 'Untitled note'
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`
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
