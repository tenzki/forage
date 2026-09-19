import { describe, expect, it } from 'vitest'
import { effectiveTools } from './tool-policy'

const tool = (name: string) => ({ name })

describe('effective sidecar tool policy', () => {
  it('uses one allowlist for built-in, custom, and extension tools and always retains emit_outline', () => {
    const selected = effectiveTools({
      builtIns: [tool('web_search'), tool('web_fetch')],
      custom: [tool('weather')],
      extensions: [tool('text_stats')],
      authorizedToolIds: new Set(['web_fetch', 'text_stats']),
      requiredToolIds: ['text_stats'],
      outputTool: tool('emit_outline'),
    })
    expect(selected.map(({ name }) => name)).toEqual(['web_fetch', 'text_stats', 'emit_outline'])
  })

  it('fails missing required tools before a model session can be created', () => {
    expect(() => effectiveTools({
      builtIns: [tool('web_search')], custom: [], extensions: [],
      authorizedToolIds: new Set(), requiredToolIds: ['web_search'], outputTool: tool('emit_outline'),
    })).toThrow(/Required tool is unavailable: web_search/)
  })

  it('does not allow another provider to replace the output tool or collide at dispatch', () => {
    expect(effectiveTools({
      builtIns: [], custom: [tool('emit_outline')], extensions: [],
      authorizedToolIds: new Set(['emit_outline']), requiredToolIds: [], outputTool: tool('emit_outline'),
    }).map(({ name }) => name)).toEqual(['emit_outline'])
    expect(() => effectiveTools({
      builtIns: [tool('same')], custom: [tool('same')], extensions: [],
      authorizedToolIds: new Set(['same']), requiredToolIds: [], outputTool: tool('emit_outline'),
    })).toThrow(/more than one active provider/i)
  })
})
