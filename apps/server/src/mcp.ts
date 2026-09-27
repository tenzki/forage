import { readFile } from 'node:fs/promises'
import { mcpImportSchema, type McpConnection, type McpRunConnection, type McpServerConfig } from '@forage/agent-runtime'
import { discoverMcp } from '@forage/mcp-host'

export function resolveMcpEnvironment(config: McpServerConfig, environment: Record<string, string | undefined>): McpServerConfig {
  const resolve = (value: string) => value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const resolved = environment[name]
    if (!resolved) throw new Error(`MCP environment variable ${name} is not configured.`)
    return resolved
  })
  if ('command' in config) return { ...config, env: Object.fromEntries(Object.entries(config.env).map(([key, value]) => [key, resolve(value)])) }
  return { ...config, headers: Object.fromEntries(Object.entries(config.headers).map(([key, value]) => [key, resolve(value)])) }
}

export async function loadBackendMcp(
  file: string | undefined,
  environment: Record<string, string | undefined> = process.env,
  discover: typeof discoverMcp = discoverMcp,
): Promise<{ inventory: McpConnection[]; connections: McpRunConnection[] }> {
  if (!file) return { inventory: [], connections: [] }
  const contents = await readFile(file, 'utf8')
  if (contents.length > 100_000) throw new Error('MCP configuration file exceeds the size limit.')
  let configs: ReturnType<typeof mcpImportSchema.parse>
  try { configs = mcpImportSchema.parse(JSON.parse(contents)) }
  catch { throw new Error('Invalid FORAGE_MCP_CONFIG. Expected mcpServers with command/args/env or url/headers.') }
  const inventory: McpConnection[] = []
  const connections: McpRunConnection[] = []
  for (const [id, raw] of Object.entries(configs.mcpServers)) {
    try {
      const config = resolveMcpEnvironment(raw, environment)
      const connection = await discover({ id, name: id, environment: 'server' }, config)
      inventory.push(connection)
      connections.push({ connection, config })
    } catch (error) {
      const detail = error instanceof Error && (error.message.startsWith('MCP:') || error.message.startsWith('MCP environment variable'))
        ? error.message.slice(0, 500) : 'MCP connection failed. Check the server configuration.'
      inventory.push({ id, name: id, environment: 'server', enabled: false, tools: [], error: detail })
    }
  }
  return { inventory, connections }
}
