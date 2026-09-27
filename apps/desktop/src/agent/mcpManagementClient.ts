import { resolveResource } from '@tauri-apps/api/path'
import { Command, type Child } from '@tauri-apps/plugin-shell'
import { mcpCandidateConfigurationSchema, mcpConnectionSchema, mcpDiscoverySchema, type McpConnection, type McpServerConfig } from '@forage/agent-runtime'

export function discoverLocalMcp(id: string, name: string, config: McpServerConfig): Promise<McpConnection> {
  return request({ id, name, config }, (response) => {
    const connection = mcpConnectionSchema.parse(response.connection)
    if (connection.id !== id || connection.environment !== 'local') throw new Error('Unexpected connection')
    return connection
  })
}

export const scanLocalMcp = () => request({ action: 'scan' }, (response) => mcpDiscoverySchema.parse(response.discovery))
export const resolveLocalMcpCandidate = (id: string, values: Record<string, string>) => request({ action: 'resolve', id, values }, (response) => mcpCandidateConfigurationSchema.parse(response.configuration))

async function request<T>(payload: unknown, parse: (response: Record<string, unknown>) => T): Promise<T> {
  const entry = await resolveResource('resources/pi/sidecar/dist/mcp-management.mjs')
  const command = Command.create('node-sidecar', [entry])
  let child: Child | undefined
  let buffer = ''
  let settled = false
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const result = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  // A spawn failure may happen before we start awaiting the result.
  void result.catch(() => undefined)
  const fail = (message: string) => {
    if (settled) return
    settled = true
    reject(new Error(message))
  }
  const timer = setTimeout(() => fail('MCP connection timed out. Check the server configuration.'), 30_000)
  command.stdout.on('data', (chunk) => {
    if (settled) return
    buffer += chunk
    if (buffer.length > 1_000_000) { fail('MCP inventory exceeded the size limit.'); return }
    const newline = buffer.indexOf('\n')
    if (newline < 0) return
    try {
      const response = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>
      if (!response.ok) { fail(typeof response.error === 'string' ? response.error.slice(0, 500) : 'MCP discovery failed.'); return }
      const value = parse(response)
      settled = true
      resolve(value)
    } catch { fail('MCP discovery returned an invalid response.') }
  })
  command.on('error', () => fail('Could not start MCP discovery. Check that Node.js is installed.'))
  command.on('close', () => { if (!settled) fail('MCP discovery exited without a result.') })
  try {
    child = await command.spawn()
    if (settled) return await result
    await child.write(`${JSON.stringify(payload)}\n`)
    return await result
  } finally {
    clearTimeout(timer)
    await child?.kill().catch(() => undefined)
  }
}
