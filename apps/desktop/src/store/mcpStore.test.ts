import { describe, expect, it, vi } from 'vitest'
import type { McpConnection } from '@forage/agent-runtime'
import { createMcpStore, type McpStoreDependencies } from './mcpStore'

const tool = { id: `mcp_l_${'a'.repeat(48)}`, remoteName: 'search', name: 'Search', description: 'Search data', inputSchema: { type: 'object' }, fingerprint: 'a'.repeat(64) }
const connection: McpConnection = { id: 'fixture', name: 'Fixture', environment: 'local', enabled: true, tools: [tool] }

function setup(initial: McpConnection[] = []) {
  let persisted = initial
  const secrets = new Map<string, string>([['forage-mcp/fixture/configuration', JSON.stringify({ command: 'node', args: ['server.mjs'], env: { TOKEN: 'private-value' } })]])
  const deps: McpStoreDependencies = {
    read: async () => persisted,
    write: vi.fn(async (value) => { persisted = value }),
    vault: { store: vi.fn(async (id, value) => { secrets.set(id, value) }), load: vi.fn(async (id) => secrets.get(id)!), remove: vi.fn(async (id) => { secrets.delete(id) }) },
    discover: vi.fn(async (id, name) => ({ ...connection, id, name })),
    deauthorize: vi.fn(async () => undefined), serverInventory: vi.fn(async () => []),
    scan: vi.fn(async () => ({ candidates: [], warnings: [] })),
    resolveCandidate: vi.fn(async () => ({ name: 'Fixture', config: { command: 'node', args: ['server.mjs'], env: {} } })),
  }
  return { store: createMcpStore(deps), deps, secrets, persisted: () => persisted }
}

describe('MCP settings store', () => {
  it('scans without launching and imports a candidate once with vaulted configuration', async () => {
    const { store, deps, persisted } = setup()
    const id = 'd'.repeat(64)
    vi.mocked(deps.scan).mockResolvedValue({ candidates: [{ id, name: 'Fixture', sources: ['Codex'], transport: 'stdio', inputs: [] }], warnings: [] })
    await store.getState().scanConnections()
    expect(deps.discover).not.toHaveBeenCalled()
    expect(deps.vault.store).not.toHaveBeenCalled()
    vi.mocked(deps.resolveCandidate).mockResolvedValue({ name: 'Fixture', config: { command: 'node', args: [], env: { TOKEN: 'candidate-secret' } } })
    const imported = await store.getState().connectCandidate(id, {}, 'My fixture')
    expect(imported).toMatchObject({ name: 'My fixture', discoveryId: id })
    expect(JSON.stringify(persisted())).not.toContain('candidate-secret')
    await expect(store.getState().connectCandidate(id, {}, 'Duplicate')).rejects.toThrow('already imported')
    expect(deps.discover).toHaveBeenCalledTimes(1)
    expect(deps.deauthorize).not.toHaveBeenCalled()
  })

  it('does not launch or save a candidate whose source changed, and permits scan retry', async () => {
    const { store, deps } = setup()
    vi.mocked(deps.resolveCandidate).mockRejectedValue(new Error('Connection changed. Scan again.'))
    await expect(store.getState().connectCandidate('d'.repeat(64), {}, 'Fixture')).rejects.toThrow('changed')
    expect(deps.discover).not.toHaveBeenCalled()
    expect(deps.vault.store).not.toHaveBeenCalled()
    vi.mocked(deps.scan).mockRejectedValueOnce(new Error('Scanner unavailable'))
    await expect(store.getState().scanConnections()).rejects.toThrow('Scanner unavailable')
    expect(store.getState().scanning).toBe(false)
    await store.getState().scanConnections()
    expect(store.getState().discoveryError).toBeNull()
  })

  it('connects from form fields with a human-readable name and vaults credentials', async () => {
    const { store, deps, persisted } = setup()
    await store.getState().addConnection(' My search server ', { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer form-secret' } })
    expect(deps.discover).toHaveBeenCalledWith(expect.any(String), 'My search server', { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer form-secret' } })
    expect(JSON.stringify(persisted())).not.toContain('form-secret')
    await expect(store.getState().addConnection('My search server', { command: 'node', args: [], env: {} })).rejects.toThrow('already exists')
    expect(deps.discover).toHaveBeenCalledTimes(1)
  })

  it('rejects invalid form fields before launching a server or saving credentials', async () => {
    const { store, deps } = setup()
    await expect(store.getState().addConnection(' ', { command: 'node', args: [], env: {} })).rejects.toThrow('server name')
    await expect(store.getState().addConnection('Search', { url: 'http://remote.example/mcp', headers: {} })).rejects.toThrow('HTTPS')
    await expect(store.getState().addConnection('Large', { command: 'node', args: [], env: Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`TOKEN_${i}`, 'x'.repeat(20_000)])) })).rejects.toThrow('size limit')
    expect(deps.discover).not.toHaveBeenCalled()
    expect(deps.vault.store).not.toHaveBeenCalled()
  })

  it('imports arbitrary servers, vaults configuration and leaves tools unauthorized', async () => {
    const { store, deps, persisted, secrets } = setup()
    await store.getState().importConnections(JSON.stringify({ mcpServers: { custom: { command: 'uvx', args: ['some-user-server'], env: { TOKEN: 'private-value' } } } }))
    expect(store.getState().connections).toHaveLength(1)
    expect(deps.discover).toHaveBeenCalledWith(expect.any(String), 'custom', expect.objectContaining({ command: 'uvx' }))
    expect(JSON.stringify(persisted())).not.toContain('private-value')
    expect([...secrets.values()].some((value) => value.includes('private-value'))).toBe(true)
    expect(deps.deauthorize).not.toHaveBeenCalled()
  })

  it('revokes changed definitions and refuses disabled or removed snapshots', async () => {
    const { store, deps } = setup([connection])
    await store.getState().load()
    expect(await store.getState().resolve([connection])).toMatchObject([{ config: { env: { TOKEN: 'private-value' } } }])
    vi.mocked(deps.discover).mockResolvedValueOnce({ ...connection, tools: [{ ...tool, id: `mcp_l_${'b'.repeat(48)}`, fingerprint: 'b'.repeat(64) }] })
    await store.getState().refresh(connection.id)
    expect(deps.deauthorize).toHaveBeenCalledWith([tool.id])
    await expect(store.getState().resolve([connection])).rejects.toThrow('changed')
    const next = store.getState().connections[0]!
    await store.getState().setEnabled(connection.id, false)
    await expect(store.getState().resolve([next])).rejects.toThrow('disabled')
    await store.getState().remove(connection.id)
    expect(store.getState().connections).toEqual([])
    expect(deps.vault.remove).toHaveBeenCalledWith('forage-mcp/fixture/configuration')
  })

  it('retains failed connections as unavailable and serializes edits', async () => {
    const { store, deps } = setup([connection])
    await store.getState().load()
    vi.mocked(deps.discover).mockRejectedValueOnce(new Error('MCP: Connection failed.'))
    await expect(store.getState().refresh(connection.id)).rejects.toThrow('Connection failed')
    expect(store.getState().connections[0]!.error).toBeTruthy()
    await expect(store.getState().resolve([connection])).rejects.toThrow()
    await Promise.all([store.getState().setEnabled(connection.id, false), store.getState().remove(connection.id)])
    expect(store.getState().connections).toEqual([])
  })

  it('does not store configuration when discovery fails or return stale backend inventory', async () => {
    const { store, deps } = setup()
    vi.mocked(deps.discover).mockRejectedValueOnce(new Error('MCP: Command not found.'))
    await expect(store.getState().importConnections('{"mcpServers":{"unknown":{"command":"missing"}}}')).rejects.toThrow('Command not found')
    expect(deps.vault.store).not.toHaveBeenCalled()
    store.setState({ serverConnections: [{ ...connection, environment: 'server' }] })
    vi.mocked(deps.serverInventory).mockRejectedValueOnce(new Error('Disconnected'))
    await expect(store.getState().loadServer()).rejects.toThrow('Disconnected')
    expect(store.getState().serverConnections).toEqual([])
  })
})
