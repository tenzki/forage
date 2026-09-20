import { describe, expect, it } from 'vitest'
import type { ExtensionJsonObject } from '@forage/extension-api'
import {
  requireSystemOneConfiguration,
  systemOneConfigurationForm,
  validateSystemOneConfiguration,
} from '../src/index.js'
import { baseConfiguration } from './fixtures.js'

describe('System One extension configuration', () => {
  it('declares bounded generic fields for every extension-owned mode', () => {
    expect(systemOneConfigurationForm.fields.map((field) => field.key)).toEqual([
      'model', 'kind', 'question', 'candidate_scope', 'ordering', 'decimal_places',
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
        { id: 'writing', label: 'Writing', description: 'Tools for drafting prose.' },
        { id: 'planning', label: 'Planning', description: 'Tools for project planning.' },
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

  it('preserves explicit ordered score levels', () => {
    const parsed = requireSystemOneConfiguration(baseConfiguration)
    expect(parsed.kind).toBe('score')
    if (parsed.kind !== 'score') throw new Error('expected score')
    expect(parsed.levels.map((level) => level.label)).toEqual(['Weak', 'Strong'])
  })

  it.each([
    ['an empty question', { ...baseConfiguration, question: '  ' }, ['question']],
    ['too few score levels', { ...baseConfiguration, levels: [{ label: 'Only', description: 'Only level' }] }, ['levels']],
    ['duplicate score labels', { ...baseConfiguration, levels: [
      { label: 'Same', description: 'Low' }, { label: 'same', description: 'High' },
    ] }, ['levels']],
    ['duplicate category IDs', {
      ...baseConfiguration, kind: 'choice-classification', categories: [
        { id: 'same', label: 'One', description: 'One' },
        { id: 'same', label: 'Two', description: 'Two' },
      ],
    }, ['categories']],
    ['invalid category ID', {
      ...baseConfiguration, kind: 'choice-classification', categories: [
        { id: 'Not Valid', label: 'One', description: 'One' },
        { id: 'valid', label: 'Two', description: 'Two' },
      ],
    }, ['categories', 0, 'id']],
    ['out-of-range threshold', { ...baseConfiguration, kind: 'noul', threshold: 1.1 }, ['threshold']],
    ['portable secret material', { ...baseConfiguration, api_key: 'must-not-be-here' }, ['api_key']],
  ])('rejects %s', (_label, configuration, path) => {
    const validation = validateSystemOneConfiguration(configuration)
    expect(validation.valid).toBe(false)
    if (validation.valid) throw new Error('expected invalid configuration')
    expect(validation.issues).toEqual(expect.arrayContaining([expect.objectContaining({ path })]))
  })
})
