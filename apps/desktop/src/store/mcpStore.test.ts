import { describe, expect, it, vi } from 'vitest'
import type { McpConnection } from '@forage/agent-runtime'
import { createMcpStore, mcpToolOptions, type McpStoreDependencies } from './mcpStore'

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
  it('ignores old-account failures and refuses an old review revision after account recovery', async () => {
    const revision = crypto.randomUUID()
    const previous: McpConnection = { ...connection, authentication: 'oauth', authorizationStatus: 'connected', authorizationRevision: revision }
    const { store } = setup([previous])
    await store.getState().load()
    const oldRevision = crypto.randomUUID()
    await store.getState().requireSignIn('fixture', oldRevision)
    expect(store.getState().connections[0]?.authorizationStatus).toBe('connected')
    await expect(store.getState().resolve([{ ...previous, authorizationRevision: oldRevision }])).rejects.toThrow('changed')
  })
  it('commits browser sign-in metadata only, without automatically enabling tools', async () => {
    const { store, deps, persisted } = setup()
    deps.authorize = vi.fn(async (id: string, name: string): Promise<McpConnection> => ({ ...connection, id, name, authentication: 'oauth', authorizationStatus: 'connected' }))
    const result = await store.getState().addConnection('OAuth fixture', { url: 'https://example.com/mcp', headers: {}, authentication: { method: 'oauth' } })
    expect(result.authentication).toBe('oauth')
    expect(deps.authorize).toHaveBeenCalledOnce()
    expect(deps.discover).not.toHaveBeenCalled()
    expect(deps.vault.store).not.toHaveBeenCalled()
    expect(deps.deauthorize).not.toHaveBeenCalled()
    expect(persisted()[0]?.tools).toEqual([tool])
  })
  it('invalidates staged OAuth credentials when metadata persistence fails', async () => {
    const { store, deps } = setup()
    deps.authorize = vi.fn(async (id: string, name: string): Promise<McpConnection> => ({ ...connection, id, name, authentication: 'oauth', authorizationStatus: 'connected' }))
    deps.invalidateAuthorization = vi.fn(async () => undefined)
    vi.mocked(deps.write).mockRejectedValueOnce(new Error('disk full'))
    await expect(store.getState().addConnection('OAuth fixture', { url: 'https://example.com/mcp', headers: {}, authentication: { method: 'oauth' } })).rejects.toThrow('disk full')
    expect(deps.invalidateAuthorization).toHaveBeenCalledOnce()
    expect(store.getState().connections).toEqual([])
  })
  it('requires explicit access review after every interactive reauthentication, even with unchanged tools', async () => {
    const previous: McpConnection = { ...connection, authentication: 'oauth', authorizationStatus: 'sign_in_required' }
    const { store, deps, secrets } = setup([previous])
    secrets.set('forage-mcp/fixture/configuration', JSON.stringify({ url: 'https://example.com/mcp', headers: {}, authentication: { method: 'oauth' } }))
    deps.authorize = vi.fn(async (): Promise<McpConnection> => ({ ...previous, authorizationStatus: 'connected' }))
    await store.getState().load()
    await expect(store.getState().resolve([previous])).rejects.toThrow('disabled')
    const next = await store.getState().signIn('fixture')
    expect(next.id).toBe('fixture')
    expect(next.tools).toEqual(previous.tools)
    expect(next.authorizationStatus).toBe('review_required')
    expect(mcpToolOptions([next])[0]?.available).toBe(false)
    await expect(store.getState().resolve([next])).rejects.toThrow('disabled')
    expect(deps.deauthorize).toHaveBeenCalledWith([])
    await store.getState().reviewAccess('fixture')
    expect(mcpToolOptions(store.getState().connections)[0]?.available).toBe(true)
    await expect(store.getState().resolve(store.getState().connections)).resolves.toHaveLength(1)
  })
  it('retains grants and credentials on failed reauthentication and removes OAuth ownership on disconnect', async () => {
    const previous: McpConnection = { ...connection, authentication: 'oauth', authorizationStatus: 'connected' }
    const { store, deps, secrets } = setup([previous])
    secrets.set('forage-mcp/fixture/configuration', JSON.stringify({ url: 'https://example.com/mcp', headers: {}, authentication: { method: 'oauth' } }))
    deps.authorize = vi.fn(async () => { throw new Error('MCP: Sign-in was denied. Try again when you are ready.') })
    deps.invalidateAuthorization = vi.fn(async () => undefined)
    await store.getState().load()
    await expect(store.getState().signIn('fixture')).rejects.toThrow('denied')
    expect(store.getState().connections[0]).toMatchObject({ authorizationStatus: 'sign_in_required', tools: [tool] })
    expect(deps.deauthorize).not.toHaveBeenCalled()
    expect(secrets.has('forage-mcp/fixture/configuration')).toBe(true)
    await store.getState().remove('fixture')
    expect(deps.invalidateAuthorization).toHaveBeenCalledWith('fixture')
    expect(deps.deauthorize).toHaveBeenCalledWith([tool.id])
  })
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
  it('retains same-name definitions as distinct candidates and imports a variant under an explicit name', async () => {
    const { store, deps } = setup()
    const first = 'd'.repeat(64)
    const second = 'e'.repeat(64)
    vi.mocked(deps.scan).mockResolvedValue({ candidates: [
      { id: first, name: 'Fixture', sources: ['Codex', 'Cursor'], transport: 'stdio', inputs: [] },
      { id: second, name: 'Fixture', sources: ['Claude Desktop'], transport: 'http', inputs: [] },
    ], warnings: [] })
    await store.getState().scanConnections()
    await store.getState().connectCandidate(first, {}, 'Fixture')
    await expect(store.getState().connectCandidate(second, {}, 'Fixture')).rejects.toThrow('already exists')
    const imported = await store.getState().connectCandidate(second, {}, 'Fixture remote')
    expect(imported.discoveryId).toBe(second)
    expect(store.getState().connections.map((entry) => entry.discoveryId)).toEqual([first, second])
    expect(deps.deauthorize).not.toHaveBeenCalled()
  })
  it('retains imported source identity after tool refresh so unchanged candidates remain deduplicated', async () => {
    const discoveryId = 'd'.repeat(64)
    const { store } = setup([{ ...connection, discoveryId }])
    await store.getState().load()
    await store.getState().refresh(connection.id)
    expect(store.getState().connections[0]!.discoveryId).toBe(discoveryId)
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
  it('returns every imported connection for explicit review and preserves partial imports without grants', async () => {
    const { store, deps } = setup()
    const imported = await store.getState().importConnections('{"mcpServers":{"first":{"command":"node"},"second":{"url":"https://example.com/mcp"}}}')
    expect(imported.map((entry) => entry.name)).toEqual(['first', 'second'])
    vi.mocked(deps.discover).mockResolvedValueOnce({ ...connection, id: 'third', name: 'third' }).mockRejectedValueOnce(new Error('MCP: Authentication failed.'))
    await expect(store.getState().importConnections('{"mcpServers":{"third":{"command":"node"},"fourth":{"command":"node"}}}')).rejects.toThrow('Authentication failed')
    expect(store.getState().connections.map((entry) => entry.name)).toEqual(['first', 'second', 'third'])
    expect(deps.deauthorize).not.toHaveBeenCalled()
  })

  it('retains approvals for updated definitions and refuses disabled or removed snapshots', async () => {
    const { store, deps } = setup([connection])
    await store.getState().load()
    expect(await store.getState().resolve([connection])).toMatchObject([{ config: { env: { TOKEN: 'private-value' } } }])
    vi.mocked(deps.discover).mockResolvedValueOnce({ ...connection, tools: [{ ...tool, id: `mcp_l_${'b'.repeat(48)}`, fingerprint: 'b'.repeat(64) }] })
    await store.getState().refresh(connection.id)
    expect(deps.deauthorize).toHaveBeenCalledWith([])
    expect(store.getState().connections[0]!.tools[0]).toMatchObject({ id: tool.id, fingerprint: 'b'.repeat(64) })
    await expect(store.getState().resolve([connection])).resolves.toHaveLength(1)
    const next = store.getState().connections[0]!
    await store.getState().setEnabled(connection.id, false)
    await expect(store.getState().resolve([next])).rejects.toThrow('disabled')
    await store.getState().remove(connection.id)
    expect(store.getState().connections).toEqual([])
    expect(deps.vault.remove).toHaveBeenCalledWith('forage-mcp/fixture/configuration')
  })

  it('revokes only removed tools and does not authorize additional tools', async () => {
    const { store, deps } = setup([connection])
    await store.getState().load()
    const additional = { ...tool, id: `mcp_l_${'b'.repeat(48)}`, remoteName: 'additional' }
    vi.mocked(deps.discover).mockResolvedValueOnce({ ...connection, tools: [additional] })
    await store.getState().refresh(connection.id)
    expect(deps.deauthorize).toHaveBeenCalledWith([tool.id])
    expect(store.getState().connections[0]!.tools).toEqual([additional])
    await expect(store.getState().resolve([connection])).rejects.toThrow('changed')
  })

  it('does not retain permission IDs when a connection binding changes', async () => {
    const bound = { ...connection, tools: [{ ...tool, bindingFingerprint: 'c'.repeat(64) }] }
    const { store, deps } = setup([bound])
    await store.getState().load()
    const replacement = { ...tool, id: `mcp_l_${'b'.repeat(48)}`, bindingFingerprint: 'd'.repeat(64) }
    vi.mocked(deps.discover).mockResolvedValueOnce({ ...connection, tools: [replacement] })
    await store.getState().refresh(connection.id)
    expect(deps.deauthorize).toHaveBeenCalledWith([tool.id])
    expect(store.getState().connections[0]!.tools).toEqual([replacement])
    await expect(store.getState().resolve([bound])).rejects.toThrow('changed')
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
