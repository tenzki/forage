// @vitest-environment node
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadBackendMcp, resolveMcpEnvironment } from './mcp'
import { buildServer } from './app'
import { InMemoryServerRepository, requireBoundOutline } from './repository'
import { FileSystemAssetStorage } from './assets'
import { createInitialOutlineState } from '@forage/domain'
import { repairSystemNodes } from '@forage/document'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
const connection = { id: 'custom', name: 'custom', environment: 'server' as const, enabled: true, tools: [{
  id: `mcp_s_${'a'.repeat(48)}`, remoteName: 'lookup', name: 'Lookup', description: 'Find records', inputSchema: { type: 'object' }, fingerprint: 'a'.repeat(64),
}] }

describe('backend MCP', () => {
  it('resolves only explicitly configured credentials and isolates unavailable servers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forage-mcp-config-'))
    roots.push(root)
    const file = join(root, 'mcp.json')
    await writeFile(file, JSON.stringify({ mcpServers: {
      custom: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${SERVICE_TOKEN}' } },
      missing: { command: 'unknown-command' },
    } }))
    const discover = vi.fn().mockResolvedValueOnce(connection).mockRejectedValueOnce(new Error('MCP: Command not found.'))
    const loaded = await loadBackendMcp(file, { SERVICE_TOKEN: 'private-backend-token', DATABASE_URL: 'do-not-forward' }, discover)
    expect(loaded.connections).toHaveLength(1)
    expect(discover.mock.calls[0]![1]).toEqual({ url: 'https://example.com/mcp', headers: { Authorization: 'Bearer private-backend-token' } })
    expect(loaded.inventory[1]).toMatchObject({ enabled: false, tools: [], error: 'MCP: Command not found.' })
    expect(JSON.stringify(loaded.inventory)).not.toContain('private-backend-token')
    expect(() => resolveMcpEnvironment({ command: 'node', args: [], env: { TOKEN: '${MISSING}' } }, {})).toThrow('not configured')
    expect(await loadBackendMcp(undefined)).toEqual({ inventory: [], connections: [] })
  })

  it('requires outline authorization and exposes only metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forage-mcp-assets-'))
    roots.push(root)
    const repository = new InMemoryServerRepository({ instanceId: 'mcp-test' })
    const owner = await repository.bootstrapOwner('owner@example.invalid')
    const unbound = await repository.authenticate(owner.deviceToken, 'sync')
    await repository.claimOutline(unbound, { outlineId: 'outline-mcp', name: 'Notes' })
    const ids = ['inbox-mcp', 'daily-mcp']
    const state = createInitialOutlineState(repairSystemNodes({ type: 'doc', content: [{ type: 'bulletList', content: [{ type: 'listItem', attrs: { nodeId: 'bullet' }, content: [{ type: 'paragraph' }] }] }] }, () => ids.shift()!).doc)
    await repository.seedOutline(requireBoundOutline(await repository.authenticate(owner.deviceToken, 'sync')), state)
    const app = buildServer({ repository, assetStorage: new FileSystemAssetStorage(root), logger: false, mcpInventory: [connection] })
    try {
      const url = '/api/v1/outlines/outline-mcp/mcp-inventory'
      expect((await app.inject({ url })).statusCode).toBe(401)
      const headers = { authorization: `Bearer ${owner.deviceToken}` }
      expect((await app.inject({ url: '/api/v1/outlines/another/mcp-inventory', headers })).statusCode).toBe(403)
      const result = await app.inject({ url, headers })
      expect(result.statusCode).toBe(200)
      expect(result.json()).toEqual([connection])
      expect(result.body).not.toContain('headers')
      expect(result.body).not.toContain('command')
    } finally { await app.close() }
  })
})
