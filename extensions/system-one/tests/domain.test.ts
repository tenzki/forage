import { describe, expect, it } from 'vitest'
import type { ExtensionJsonObject } from '@forage/extension-api'
import {
  requireSystemOneConfiguration,
  resolveSystemOneQuestion,
  systemOneConfigurationForm,
  validateSystemOneConfiguration,
} from '../src/index.js'
import { baseConfiguration } from './fixtures.js'

describe('System One extension configuration', () => {
  it('declares bounded generic fields for every extension-owned mode', () => {
    expect(systemOneConfigurationForm.fields.map((field) => field.key)).toEqual([
      'model', 'kind', 'question', 'candidate_scope', 'output',
    ])
    expect(systemOneConfigurationForm.branches.map((branch) => branch.when.equals)).toEqual([
      'choice-classification', 'score', 'noul',
    ])
  })

  it.each([
    ['idea comparison', { ...baseConfiguration, kind: 'choice-comparison', levels: undefined }],
    ['tool classification', {
      ...baseConfiguration,
      kind: 'choice-classification',
      categories: [
        { label: 'Writing', description: 'Tools for drafting prose.' },
        { label: 'Planning', description: 'Tools for project planning.' },
      ],
    }],
    ['outreach score', baseConfiguration],
    ['note filter', {
      ...baseConfiguration,
      kind: 'noul', threshold: 0.8,
      yes_definition: 'The note contains a concrete next action.',
      no_definition: 'The note is informational only.',
    }],
  ])('accepts a complete %s configuration', (_label, configuration) => {
    const clean = Object.fromEntries(Object.entries(configuration).filter(([, value]) => value !== undefined)) as ExtensionJsonObject
    expect(validateSystemOneConfiguration(clean)).toEqual({ valid: true })
  })

  it('defaults to list output and limits in-place reordering to siblings', () => {
    expect(requireSystemOneConfiguration(baseConfiguration).output).toBe('list')
    expect(requireSystemOneConfiguration({ ...baseConfiguration, output: 'reorder' }).output).toBe('reorder')
    const invalid = validateSystemOneConfiguration({
      ...baseConfiguration, output: 'reorder', candidate_scope: 'descendants',
    })
    expect(invalid.valid ? [] : invalid.issues.map((entry) => entry.path)).toEqual([['candidate_scope']])
    expect(validateSystemOneConfiguration({ ...baseConfiguration, output: 'replace' }).valid).toBe(false)
  })

  it('derives category tags from labels and limits tag output to classification and Noul', () => {
    const classification = {
      ...baseConfiguration,
      kind: 'choice-classification', output: 'tag', minimum_probability: 0.6,
      categories: [
        { label: 'Build later', description: 'Build after launch.' },
        { label: 'Now', description: 'Build now.', tag: '#Ship-It' },
      ],
    }
    const parsed = requireSystemOneConfiguration(classification)
    expect(parsed.kind === 'choice-classification' && parsed.categories.map((category) => category.tag))
      .toEqual(['build-later', 'ship-it'])
    expect(parsed.kind === 'choice-classification' && parsed.minimumProbability).toBe(0.6)

    const paths = (configuration: ExtensionJsonObject) => {
      const result = validateSystemOneConfiguration(configuration)
      return result.valid ? [] : result.issues.map((entry) => entry.path)
    }
    expect(paths({ ...baseConfiguration, output: 'tag' })).toEqual([['output']])
    expect(paths({
      ...classification,
      categories: [
        { label: 'Now', description: 'Build now.' },
        { label: 'Later', description: 'Build later.', tag: 'now' },
      ],
    })).toEqual([['categories']])
    expect(paths({
      ...classification,
      categories: [
        { label: '???', description: 'Unclear.' },
        { label: 'Now', description: 'Build now.', tag: 'two words' },
      ],
    })).toEqual([['categories', 0, 'tag'], ['categories', 1, 'tag']])

    const noul = { ...baseConfiguration, kind: 'noul', threshold: 0.8, output: 'tag' }
    expect(paths(noul)).toEqual([['tag']])
    expect(paths({ ...noul, tag: '' })).toEqual([['tag']])
    const parsedNoul = requireSystemOneConfiguration({ ...noul, tag: '#Actionable' })
    expect(parsedNoul.kind === 'noul' && parsedNoul.tag).toBe('actionable')
  })

  it('treats the question as an optional default resolved against typed text', () => {
    const { question: _question, ...withoutQuestion } = baseConfiguration
    const parsed = requireSystemOneConfiguration({ ...withoutQuestion, question: '  ' })
    expect(parsed.question).toBeUndefined()
    expect(resolveSystemOneQuestion(parsed, ' Which ships first? ')).toBe('Which ships first?')
    expect(() => resolveSystemOneQuestion(parsed, '')).toThrow(/no default question/)
    const withDefault = requireSystemOneConfiguration(baseConfiguration)
    expect(resolveSystemOneQuestion(withDefault, '')).toBe('How promising is this idea?')
    expect(resolveSystemOneQuestion(withDefault, 'Typed wins')).toBe('Typed wins')
  })

  it('rejects fields retired by the simplified configuration', () => {
    for (const configuration of [
      { ...baseConfiguration, ordering: 'descending' },
      { ...baseConfiguration, decimal_places: 2 },
      {
        ...baseConfiguration, kind: 'choice-classification', categories: [
          { id: 'build', label: 'Build', description: 'Build now.' },
          { label: 'Defer', description: 'Defer it.' },
        ],
      },
    ] as ExtensionJsonObject[]) expect(validateSystemOneConfiguration(configuration).valid).toBe(false)
  })

  it('preserves explicit ordered score levels', () => {
    const parsed = requireSystemOneConfiguration(baseConfiguration)
    expect(parsed.kind).toBe('score')
    if (parsed.kind !== 'score') throw new Error('expected score')
    expect(parsed.levels.map((level) => level.label)).toEqual(['Weak', 'Strong'])
  })

  it.each([
    ['an overlong question', { ...baseConfiguration, question: 'x'.repeat(2_001) }, ['question']],
    ['too few score levels', { ...baseConfiguration, levels: [{ label: 'Only', description: 'Only level' }] }, ['levels']],
    ['duplicate score labels', { ...baseConfiguration, levels: [
      { label: 'Same', description: 'Low' }, { label: 'same', description: 'High' },
    ] }, ['levels']],
    ['duplicate category labels', {
      ...baseConfiguration, kind: 'choice-classification', categories: [
        { label: 'Same', description: 'One' },
        { label: 'same', description: 'Two' },
      ],
    }, ['categories']],
    ['out-of-range threshold', { ...baseConfiguration, kind: 'noul', threshold: 1.1 }, ['threshold']],
    ['portable secret material', { ...baseConfiguration, api_key: 'must-not-be-here' }, ['api_key']],
  ])('rejects %s', (_label, configuration, path) => {
    const validation = validateSystemOneConfiguration(configuration)
    expect(validation.valid).toBe(false)
    if (validation.valid) throw new Error('expected invalid configuration')
    expect(validation.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path })]))
  })
})
