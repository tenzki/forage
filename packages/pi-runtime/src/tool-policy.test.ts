import { describe, expect, it } from 'vitest'
import { AgentRuntimeError } from '@forage/agent-runtime'
import { selectEffectiveTools } from './tool-policy'

const tool = (name: string) => ({ name })

describe('effective tool policy', () => {
  it('uses one allowlist for every tool provider and always retains emit_outline', () => {
    const selected = selectEffectiveTools({
      tools: [tool('web_search'), tool('web_fetch'), tool('weather'), tool('text_stats')],
      authorizedToolIds: new Set(['web_fetch', 'text_stats']),
      requiredToolIds: ['text_stats'],
      outputTool: tool('emit_outline'),
    })
    expect(selected.map(({ name }) => name)).toEqual(['web_fetch', 'text_stats', 'emit_outline'])
  })

  it('fails missing required tools with the unsupported-tool code before a model session can be created', () => {
    const select = () => selectEffectiveTools({
      tools: [tool('web_search')],
      authorizedToolIds: new Set(), requiredToolIds: ['web_search'], outputTool: tool('emit_outline'),
    })
    expect(select).toThrow(/Required tool is unavailable: web_search/)
    expect(select).toThrow(AgentRuntimeError)
    try { select() } catch (error) { expect((error as AgentRuntimeError).code).toBe('required_tool_unavailable') }
  })

  it('does not allow another provider to replace the output tool or collide at dispatch', () => {
    expect(selectEffectiveTools({
      tools: [tool('emit_outline')],
      authorizedToolIds: new Set(['emit_outline']), requiredToolIds: [], outputTool: tool('emit_outline'),
    }).map(({ name }) => name)).toEqual(['emit_outline'])
    expect(() => selectEffectiveTools({
      tools: [tool('same'), tool('same')],
      authorizedToolIds: new Set(['same']), requiredToolIds: [], outputTool: tool('emit_outline'),
    })).toThrow(/more than one active provider/i)
  })
})
