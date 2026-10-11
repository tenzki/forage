import { describe, expect, it } from 'vitest'
import { normalizeCustomToolReferences } from './runtimeToolReferences'

const customTool = {
  id: '550e8400-e29b-41d4-a716-446655440000', name: 'public_weather',
  description: 'Read public weather', urlTemplate: 'https://api.open-meteo.com/v1/forecast?latitude={{latitude}}',
}

describe('runtime custom-tool references', () => {
  it('maps legacy UUIDs consistently without changing MCP or missing source identities', () => {
    const mcpId = `mcp_l_${'a'.repeat(48)}`
    const normalized = normalizeCustomToolReferences([customTool])
    expect(normalized.customTools).toEqual([{ ...customTool, id: customTool.name }])
    expect(normalized.normalizeToolIds(['web_fetch', customTool.id, mcpId, customTool.id, 'missing_tool'])).toEqual(['web_fetch', customTool.name, mcpId, 'missing_tool'])
    expect(customTool.id).toBe('550e8400-e29b-41d4-a716-446655440000')
  })

  it('preserves existing valid identifiers used by portable configurations', () => {
    const normalized = normalizeCustomToolReferences([{ ...customTool, id: 'weather' }])
    expect(normalized.customTools[0]!.id).toBe('weather')
    expect(normalized.normalizeToolIds(['weather'])).toEqual(['weather'])
  })

  it('rejects aliases that collide with another source or another custom tool', () => {
    expect(() => normalizeCustomToolReferences([customTool], [customTool.name])).toThrow(/conflicts/)
    expect(() => normalizeCustomToolReferences([customTool, { ...customTool, id: 'another-legacy-id' }])).toThrow(/conflicts/)
  })
})
