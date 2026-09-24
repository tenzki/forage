import { describe, expect, it } from 'vitest'
import {
  formatSystemOneResult,
  type ChoiceAnswer,
  type NoulAnswer,
  type ScoreAnswer,
  type SystemOneConfiguration,
} from '../src/index.js'
import { evaluation, preparedData, scoreConfiguration } from './fixtures.js'

type Result = ReturnType<typeof formatSystemOneResult>
type ResultNode = Result['nodes'][number]

function rowIds(nodes: readonly ResultNode[]): string[] {
  return nodes.flatMap((node) => [
    ...node.segments.flatMap((segment) => segment.type === 'internal-reference' ? [segment.nodeId] : []),
    ...rowIds(node.children ?? []),
  ])
}

function lines(nodes: readonly ResultNode[], depth = 0): string[] {
  return nodes.flatMap((node) => [
    `${'  '.repeat(depth)}${node.segments.map((segment) => segment.type === 'text' ? segment.text : `[[${segment.label}]]`).join('')}`,
    ...(node.note ? [`${'  '.repeat(depth)}  note: ${node.note}`] : []),
    ...lines(node.children ?? [], depth + 1),
  ])
}

const twoLevelScores = new Map<string, ScoreAnswer>([
  ['candidate_0', { type: 'score', score: 0.2, legend: { 0: 'Weak', 1: 'Strong' }, probabilities: { 0: 0.8, 1: 0.2 }, confidence: 0.7 }],
  ['candidate_1', { type: 'score', score: 0.9, legend: { 0: 'Weak', 1: 'Strong' }, probabilities: { 0: 0.1, 1: 0.9 }, confidence: 0.9 }],
])

describe('System One ordinary linked output', () => {
  it('uses typed text as the question and places rows directly under the invocation', () => {
    const result = formatSystemOneResult(scoreConfiguration(), preparedData, evaluation(twoLevelScores), 'Which ships first?')
    expect(lines(result.nodes)).toEqual([
      '[[Keyboard navigation]] Strong',
      '  note: Score 0.90 of 1 · confidence 90%',
      '[[Offline capture]] Weak',
      '  note: Score 0.20 of 1 · confidence 70%',
    ])
  })

  it('roots rows under the default question when the invocation has no typed text', () => {
    const configuration = scoreConfiguration()
    const result = formatSystemOneResult(configuration, preparedData, evaluation(twoLevelScores), '  ')
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0]?.segments).toEqual([{ type: 'text', text: configuration.question }])
    expect(result.nodes[0]?.note).toBeUndefined()
    expect(rowIds(result.nodes)).toEqual(['idea-b', 'idea-a'])
  })

  it('marks the selected comparative Choice and keeps probabilities in notes', () => {
    const configuration: SystemOneConfiguration = { ...scoreConfiguration(), kind: 'choice-comparison' }
    const answer: ChoiceAnswer = {
      type: 'choice', choice: 'option_1', probabilities: { option_0: 0.25, option_1: 0.75 }, confidence: 0.8,
    }
    const result = formatSystemOneResult(configuration, preparedData, evaluation(new Map([['comparison', answer]])), 'Best?')
    expect(lines(result.nodes)).toEqual([
      '[[Keyboard navigation]] ★',
      '  note: Probability 75% · confidence 80%',
      '[[Offline capture]]',
      '  note: Probability 25% · confidence 80%',
    ])
  })

  it('groups Choice classification by configured category order and omits empty categories', () => {
    const configuration: SystemOneConfiguration = {
      ...scoreConfiguration(), kind: 'choice-classification',
      categories: [
        { label: 'Build', description: 'Build now.' },
        { label: 'Later', description: 'Revisit next quarter.' },
        { label: 'Defer', description: 'Defer it.' },
      ],
    }
    const answers = new Map<string, ChoiceAnswer>([
      ['candidate_0', { type: 'choice', choice: 'category_2', probabilities: { category_0: 0.1, category_1: 0.2, category_2: 0.7 }, confidence: 0.4 }],
      ['candidate_1', { type: 'choice', choice: 'category_0', probabilities: { category_0: 0.8, category_1: 0.1, category_2: 0.1 }, confidence: 0.6 }],
    ])
    const result = formatSystemOneResult(configuration, preparedData, evaluation(answers), 'Bucket?')
    expect(lines(result.nodes)).toEqual([
      'Build',
      '  [[Keyboard navigation]]',
      '    note: Probability 80% · confidence 60%',
      'Defer',
      '  [[Offline capture]]',
      '    note: Probability 70% · confidence 40%',
    ])
  })

  it('lists classifications below the minimum probability under Unclassified with their best guess', () => {
    const configuration: SystemOneConfiguration = {
      ...scoreConfiguration(), kind: 'choice-classification', minimumProbability: 0.6,
      categories: [
        { label: 'Build', description: 'Build now.' },
        { label: 'Defer', description: 'Defer it.' },
      ],
    }
    const answers = new Map<string, ChoiceAnswer>([
      ['candidate_0', { type: 'choice', choice: 'category_0', probabilities: { category_0: 0.55, category_1: 0.45 }, confidence: 0.3 }],
      ['candidate_1', { type: 'choice', choice: 'category_1', probabilities: { category_0: 0.1, category_1: 0.9 }, confidence: 0.8 }],
    ])
    expect(lines(formatSystemOneResult(configuration, preparedData, evaluation(answers), 'Bucket?').nodes)).toEqual([
      'Defer',
      '  [[Keyboard navigation]]',
      '    note: Probability 90% · confidence 80%',
      'Unclassified',
      '  [[Offline capture]] Build',
      '    note: Probability 55% · confidence 30%',
    ])
    // Reordering moves the uncertain candidate after every classified one.
    expect(formatSystemOneResult({ ...configuration, output: 'reorder' }, preparedData, evaluation(answers), '').reorder)
      .toEqual({ nodeIds: ['idea-b', 'idea-a'] })
  })

  it('names the closest rubric level and breaks Score ties by document order', () => {
    const configuration = scoreConfiguration({
      levels: [
        { label: 'Weak', description: 'Unclear value.' },
        { label: 'Plausible', description: 'Clear value with unknowns.' },
        { label: 'Strong', description: 'Clear value and achievable.' },
      ],
    })
    const answers = new Map<string, ScoreAnswer>([
      ['candidate_0', { type: 'score', score: 1.62, legend: { 0: 'Weak', 1: 'Plausible', 2: 'Strong' }, probabilities: { 0: 0.05, 1: 0.28, 2: 0.67 }, confidence: 0.9 }],
      ['candidate_1', { type: 'score', score: 1.62, legend: { 0: 'Weak', 1: 'Plausible', 2: 'Strong' }, probabilities: { 0: 0.05, 1: 0.28, 2: 0.67 }, confidence: 0.9 }],
    ])
    const result = formatSystemOneResult(configuration, preparedData, evaluation(answers), 'Rate')
    expect(rowIds(result.nodes)).toEqual(['idea-a', 'idea-b'])
    expect(lines(result.nodes)[0]).toBe('[[Offline capture]] Strong')
    expect(lines(result.nodes)[1]).toBe('  note: Score 1.62 of 2 · confidence 90%')
  })

  it('uses inclusive raw Noul thresholds and never invents confidence', () => {
    const configuration: SystemOneConfiguration = {
      ...scoreConfiguration(), kind: 'noul', threshold: 0.8,
      yesDefinition: 'Actionable', noDefinition: 'Not actionable',
    }
    const answers = new Map<string, NoulAnswer>([
      ['candidate_0', { type: 'noul', noul: 0.8 }],
      ['candidate_1', { type: 'noul', noul: 0.7999 }],
    ])
    const result = formatSystemOneResult(configuration, preparedData, evaluation(answers), 'Actionable?')
    expect(lines(result.nodes)).toEqual(['[[Offline capture]]', '  note: Yes probability 80%'])
  })

  it('returns an ordinary no-matches line with the threshold', () => {
    const configuration: SystemOneConfiguration = { ...scoreConfiguration(), kind: 'noul', threshold: 0.9 }
    const answers = new Map<string, NoulAnswer>([
      ['candidate_0', { type: 'noul', noul: 0.2 }],
      ['candidate_1', { type: 'noul', noul: 0.4 }],
    ])
    const result = formatSystemOneResult(configuration, preparedData, evaluation(answers), '')
    expect(rowIds(result.nodes)).toEqual([])
    expect(lines(result.nodes)).toEqual([configuration.question, '  No matches reached the yes threshold of 90%.'])
  })

  it('returns only a highest-first sibling reorder when reordering in place', () => {
    const result = formatSystemOneResult(
      scoreConfiguration({ output: 'reorder' }),
      preparedData,
      evaluation(twoLevelScores),
      '',
    )
    expect(result).toEqual({ nodes: [], reorder: { nodeIds: ['idea-b', 'idea-a'] } })
  })

  it('tags each classified candidate with its category and clears the rest of the vocabulary', () => {
    const configuration: SystemOneConfiguration = {
      ...scoreConfiguration(), kind: 'choice-classification', output: 'tag', minimumProbability: 0.5,
      categories: [
        { label: 'Build', description: 'Build now.', tag: 'build' },
        { label: 'Defer', description: 'Defer it.', tag: 'defer' },
      ],
    }
    const answers = new Map<string, ChoiceAnswer>([
      ['candidate_0', { type: 'choice', choice: 'category_1', probabilities: { category_0: 0.6, category_1: 0.4 }, confidence: 0.4 }],
      ['candidate_1', { type: 'choice', choice: 'category_0', probabilities: { category_0: 0.8, category_1: 0.2 }, confidence: 0.6 }],
    ])
    expect(formatSystemOneResult(configuration, preparedData, evaluation(answers), '')).toEqual({
      nodes: [],
      tags: [
        { nodeId: 'idea-b', add: ['build'], remove: ['defer'] },
        // Below the minimum probability, so no category tag remains.
        { nodeId: 'idea-a', add: [], remove: ['build', 'defer'] },
      ],
    })
  })

  it('adds the Noul tag at or above the threshold and removes it below', () => {
    const configuration: SystemOneConfiguration = {
      ...scoreConfiguration(), kind: 'noul', output: 'tag', threshold: 0.8, tag: 'actionable',
    }
    const answers = new Map<string, NoulAnswer>([
      ['candidate_0', { type: 'noul', noul: 0.8 }],
      ['candidate_1', { type: 'noul', noul: 0.3 }],
    ])
    expect(formatSystemOneResult(configuration, preparedData, evaluation(answers), 'Actionable?').tags).toEqual([
      { nodeId: 'idea-a', add: ['actionable'] },
      { nodeId: 'idea-b', add: [], remove: ['actionable'] },
    ])
  })

  it('keeps every Noul candidate when reordering so none is left out of place', () => {
    const configuration: SystemOneConfiguration = {
      ...scoreConfiguration(), kind: 'noul', output: 'reorder', threshold: 0.9,
    }
    const answers = new Map<string, NoulAnswer>([
      ['candidate_0', { type: 'noul', noul: 0.2 }],
      ['candidate_1', { type: 'noul', noul: 0.4 }],
    ])
    expect(formatSystemOneResult(configuration, preparedData, evaluation(answers), '').reorder)
      .toEqual({ nodeIds: ['idea-b', 'idea-a'] })
  })
})
