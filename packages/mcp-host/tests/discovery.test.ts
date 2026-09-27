import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverConfiguredMcp, discoverySources, resolveConfiguredMcp, type DiscoveryOptions } from '../src/discovery'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'forage-mcp-discovery-'))
  roots.push(home)
  const options: DiscoveryOptions = { home, platform: 'darwin', env: {} }
  const write = async (source: string, text: string) => {
    const path = discoverySources(options).find((entry) => entry.name === source)!.path
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, text)
    return path
  }
  return { options, write }
}

describe('discovery of configured MCP connections', () => {
  it('reads Pen-style Codex TOML and other client JSON without launching or exposing configuration', async () => {
    const { options, write } = await fixture()
    const text = '[mcp_servers.pencil]\ncommand = "/Applications/Pen.app/Contents/Resources/mcp-server"\nargs = ["--app", "desktop"]\nenv = { TOKEN = "private-token" }\n'
    const path = await write('Codex', text)
    await write('Claude Desktop', JSON.stringify({ mcpServers: { pencil: { command: '/Applications/Pen.app/Contents/Resources/mcp-server', args: ['--app', 'desktop'], env: { TOKEN: 'private-token' } } } }))
    await write('Cursor', JSON.stringify({ mcpServers: { search: { url: 'https://search.example/mcp', headers: { Authorization: 'Bearer private-header' } } } }))
    const discovery = await discoverConfiguredMcp(options)
    expect(discovery.candidates).toHaveLength(2)
    expect(discovery.candidates[0]).toMatchObject({ name: 'pencil', sources: ['Codex', 'Claude Desktop'], transport: 'stdio', inputs: [] })
    expect(JSON.stringify(discovery)).not.toMatch(/private-token|private-header|\/Applications|command|Authorization/)
    expect(await resolveConfiguredMcp(discovery.candidates[0]!.id, {}, options)).toMatchObject({ config: { command: '/Applications/Pen.app/Contents/Resources/mcp-server', env: { TOKEN: 'private-token' } } })
    expect(await readFile(path, 'utf8')).toBe(text)
  })

  it('handles JSON comments and trailing commas, ignores project entries, and reports bad sources independently', async () => {
    const { options, write } = await fixture()
    await write('VS Code', '{ // personal settings\n "servers": { "search": { "url": "https://example.com/mcp", }, }, }')
    await write('Claude Code', JSON.stringify({ mcpServers: { own: { command: 'my-server' } }, projects: { '/project': { mcpServers: { ignored: { command: 'ignored' } } } } }))
    await write('Cursor', '{secret-token-is-not-json')
    const found = await discoverConfiguredMcp(options)
    expect(found.candidates.map((candidate) => candidate.name)).toEqual(['own', 'search'])
    expect(found.warnings).toEqual(['Cursor: could not read its MCP configuration.'])
  })

  it('asks for missing values and never imports unresolved placeholders or unrelated credentials', async () => {
    const { options, write } = await fixture()
    await write('Codex', '[mcp_servers.search]\nurl = "https://example.com/mcp"\nbearer_token_env_var = "SEARCH_TOKEN"\n')
    const found = await discoverConfiguredMcp(options)
    const candidate = found.candidates[0]!
    expect(candidate.inputs).toEqual([{ key: 'header:Authorization', label: 'Authorization header (Bearer token)' }])
    await expect(resolveConfiguredMcp(candidate.id, {}, options)).rejects.toThrow('requested credential')
    await expect(resolveConfiguredMcp(candidate.id, { unexpected: 'value' }, options)).rejects.toThrow('Unexpected')
    expect(await resolveConfiguredMcp(candidate.id, { 'header:Authorization': 'Bearer supplied' }, options)).toMatchObject({ config: { headers: { Authorization: 'Bearer supplied' } } })
    const configured = await discoverConfiguredMcp({ ...options, env: { SEARCH_TOKEN: 'known', DATABASE_URL: 'unrelated' } })
    expect(configured.candidates[0]!.inputs).toEqual([])
    expect(await resolveConfiguredMcp(configured.candidates[0]!.id, {}, { ...options, env: { SEARCH_TOKEN: 'known' } })).toMatchObject({ config: { headers: { Authorization: 'Bearer known' } } })
    await write('Cursor', JSON.stringify({ mcpServers: { local: { command: 'node', env: { TOKEN: '${env:LOCAL_TOKEN}' } } } }))
    const local = (await discoverConfiguredMcp(options)).candidates.find((candidate) => candidate.name === 'local')!
    expect(local.inputs).toEqual([{ key: 'env:TOKEN', label: 'TOKEN environment variable' }])
    expect(await resolveConfiguredMcp(local.id, { 'env:TOKEN': 'literal-value' }, options)).toMatchObject({ config: { env: { TOKEN: 'literal-value' } } })
  })

  it('rejects source changes between scanning and connecting', async () => {
    const { options, write } = await fixture()
    await write('Cursor', '{"mcpServers":{"one":{"command":"old"}}}')
    const id = (await discoverConfiguredMcp(options)).candidates[0]!.id
    await write('Cursor', '{"mcpServers":{"one":{"command":"new"}}}')
    await expect(resolveConfiguredMcp(id, {}, options)).rejects.toThrow('changed or was removed')
  })

  it('keeps disabled and unsupported configurations visible without making them connectable', async () => {
    const { options, write } = await fixture()
    await write('Cursor', JSON.stringify({ mcpServers: {
      disabled: { command: 'node', disabled: true },
      oauth: { url: 'https://example.com/mcp', auth: { clientId: 'private' } },
      sse: { type: 'sse', url: 'https://example.com/sse' },
      variable: { command: '${workspaceFolder}/server' },
      malformed: { command: 'node', env: ['bad'] },
      restricted: { command: 'node', disabled_tools: ['delete'] },
    } }))
    const found = await discoverConfiguredMcp(options)
    expect(found.candidates).toHaveLength(6)
    for (const candidate of found.candidates) {
      expect(candidate.issue).toBeTruthy()
      await expect(resolveConfiguredMcp(candidate.id, {}, options)).rejects.toThrow('MCP:')
    }
  })

  it('bounds input files and candidates and handles configuration home overrides', async () => {
    const { options, write } = await fixture()
    await write('Codex', 'x'.repeat(1_000_001))
    await write('Cursor', JSON.stringify({ mcpServers: Object.fromEntries(Array.from({ length: 105 }, (_, i) => [`server${i}`, { command: `cmd${i}` }])) }))
    const found = await discoverConfiguredMcp(options)
    expect(found.candidates).toHaveLength(100)
    expect(found.warnings).toHaveLength(2)
    expect(discoverySources({ ...options, env: { CODEX_HOME: '/custom/codex' } })[0]!.path).toBe('/custom/codex/config.toml')
    expect(discoverySources({ ...options, platform: 'linux', env: { XDG_CONFIG_HOME: '/custom/config' } }).find((source) => source.name === 'VS Code')!.path).toBe('/custom/config/Code/User/mcp.json')
  })
})
