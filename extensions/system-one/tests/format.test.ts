import { describe, expect, it } from 'vitest'
import {
  formatSystemOneResult,
  type ChoiceAnswer,
  type NoulAnswer,
  type ScoreAnswer,
  type SystemOneConfiguration,
} from '../src/index.js'
import { evaluation, preparedData, scoreConfiguration } from './fixtures.js'

function rowIds(result: ReturnType<typeof formatSystemOneResult>): string[] {
  return result.nodes[0]?.children?.flatMap((node) => node.segments.flatMap((segment) => (
    segment.type === 'internal-reference' ? [segment.nodeId] : []
  ))) ?? []
}

function visible(result: ReturnType<typeof formatSystemOneResult>): string {
  const walk = (nodes: typeof result.nodes): string[] => nodes.flatMap((node) => [
    node.segments.map((segment) => segment.type === 'text' ? segment.text : segment.label).join(''),
    ...walk(node.children ?? []),
  ])
  return walk(result.nodes).join('\n')
}

describe('System One ordinary linked output', () => {
  it('formats comparative Choice probabilities, selected option, confidence, and raw-value ordering', () => {
    const configuration: SystemOneConfiguration = {
      ...scoreConfiguration(), kind: 'choice-comparison', ordering: 'descending', decimalPlaces: 1,
    }
    const answer: ChoiceAnswer = {
      type: 'choice', choice: 'option_1', probabilities: { option_0: 0.25, option_1: 0.75 }, confidence: 0.8,
    }
    const result = formatSystemOneResult(configuration, preparedData, evaluation(new Map([['comparison', answer]])))
    expect(rowIds(result)).toEqual(['idea-b', 'idea-a'])
    expect(visible(result)).toContain('Probability: 75.0%; selected: yes; confidence: 80.0%')
    expect(result.nodes[0]?.children?.find((node) => node.segments.some((segment) => segment.type === 'internal-reference')))
      .toBeDefined()
  })

  it('formats Choice classification categories without changing stable links', () => {
    const configuration: SystemOneConfiguration = {
      ...scoreConfiguration(), kind: 'choice-classification', ordering: 'document',
      categories: [
        { id: 'build', label: 'Build', description: 'Build now.' },
        { id: 'defer', label: 'Defer', description: 'Defer it.' },
      ],
    }
    const answers = new Map<string, ChoiceAnswer>([
      ['candidate_0', { type: 'choice', choice: 'build', probabilities: { build: 0.7, defer: 0.3 }, confidence: 0.4 }],
      ['candidate_1', { type: 'choice', choice: 'defer', probabilities: { build: 0.2, defer: 0.8 }, confidence: 0.6 }],
    ])
    const result = formatSystemOneResult(configuration, preparedData, evaluation(answers))
    expect(rowIds(result)).toEqual(['idea-a', 'idea-b'])
    expect(visible(result)).toContain('Categories: Build — Build now.; Defer — Defer it.')
    expect(visible(result)).toContain('Category: Build; probability: 70.00%; confidence: 40.00%')
  })

  it('sorts Score values numerically with document-order ties and labels confidence separately', () => {
    const configuration = scoreConfiguration({ ordering: 'ascending', decimalPlaces: 3 })
    const answers = new Map<string, ScoreAnswer>([
      ['candidate_0', { type: 'score', score: 0.3334, legend: { 0: 'Weak', 1: 'Strong' }, probabilities: { 0: 0.6666, 1: 0.3334 }, confidence: 0.5 }],
      ['candidate_1', { type: 'score', score: 0.3333, legend: { 0: 'Weak', 1: 'Strong' }, probabilities: { 0: 0.6667, 1: 0.3333 }, confidence: 0.6 }],
    ])
    const result = formatSystemOneResult(configuration, preparedData, evaluation(answers))
    expect(rowIds(result)).toEqual(['idea-b', 'idea-a'])
    expect(visible(result)).toContain('Score: 0.333; confidence: 60.000%')

    const tied = new Map<string, ScoreAnswer>([
      ['candidate_0', { ...answers.get('candidate_0')!, score: 0.5 }],
      ['candidate_1', { ...answers.get('candidate_1')!, score: 0.5 }],
    ])
    expect(rowIds(formatSystemOneResult({ ...configuration, ordering: 'descending' }, preparedData, evaluation(tied))))
      .toEqual(['idea-a', 'idea-b'])
  })

  it('uses inclusive raw Noul thresholds before display rounding and never invents confidence', () => {
    const configuration: SystemOneConfiguration = {
      ...scoreConfiguration(), kind: 'noul', ordering: 'descending', decimalPlaces: 0, threshold: 0.8,
      yesDefinition: 'Actionable', noDefinition: 'Not actionable',
    }
    const answers = new Map<string, NoulAnswer>([
      ['candidate_0', { type: 'noul', noul: 0.8 }],
      ['candidate_1', { type: 'noul', noul: 0.7999 }],
    ])
    const result = formatSystemOneResult(configuration, preparedData, evaluation(answers))
    expect(rowIds(result)).toEqual(['idea-a'])
    expect(visible(result)).toContain('Yes probability: 80%')
    expect(visible(result)).not.toContain('confidence')
  })

  it('returns an ordinary no-matches summary with the threshold', () => {
    const configuration: SystemOneConfiguration = {
      ...scoreConfiguration(), kind: 'noul', ordering: 'document', decimalPlaces: 2, threshold: 0.9,
    }
    const answers = new Map<string, NoulAnswer>([
      ['candidate_0', { type: 'noul', noul: 0.2 }],
      ['candidate_1', { type: 'noul', noul: 0.4 }],
    ])
    const result = formatSystemOneResult(configuration, preparedData, evaluation(answers))
    expect(rowIds(result)).toEqual([])
    expect(visible(result)).toContain('No matches met the inclusive yes-probability threshold of 90.00%.')
  })
})
