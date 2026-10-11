import { describe, expect, it } from 'vitest'
import { retainMcpToolIds, type McpConnection } from './mcp'

const tool = { id: `mcp_l_${'a'.repeat(48)}`, remoteName: 'search', name: 'Search', description: 'Search', inputSchema: { type: 'object' }, fingerprint: 'a'.repeat(64) }
const previous: McpConnection = { id: 'fixture', name: 'Fixture', environment: 'local', enabled: true, tools: [tool] }
const updated = { ...tool, id: `mcp_l_${'b'.repeat(48)}`, fingerprint: 'b'.repeat(64), bindingFingerprint: 'c'.repeat(64) }

describe('MCP approval identities', () => {
  it('retains legacy IDs when definitions change and leaves new tools unaliased', () => {
    const added = { ...updated, id: `mcp_l_${'d'.repeat(48)}`, remoteName: 'additional' }
    const next = { ...previous, tools: [updated, added] }
    expect(retainMcpToolIds(previous, next).tools).toEqual([{ ...updated, id: tool.id }, added])
    expect(next.tools[0]!.id).toBe(updated.id)
  })

  it('retains IDs for the same binding but never for a different binding', () => {
    const bound = { ...previous, tools: [{ ...tool, bindingFingerprint: updated.bindingFingerprint }] }
    expect(retainMcpToolIds(bound, { ...previous, tools: [updated] }).tools[0]!.id).toBe(tool.id)
    const changed = { ...updated, bindingFingerprint: 'd'.repeat(64) }
    expect(retainMcpToolIds(bound, { ...previous, tools: [changed] }).tools[0]!.id).toBe(updated.id)
  })

  it('does not carry identities to another connection or environment', () => {
    const other = { ...previous, id: 'other', tools: [updated] }
    expect(retainMcpToolIds(previous, other)).toBe(other)
    const server = { ...previous, environment: 'server' as const, tools: [updated] }
    expect(retainMcpToolIds(previous, server)).toBe(server)
  })
})
