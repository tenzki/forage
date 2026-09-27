#!/usr/bin/env node
import { mcpServerConfigSchema } from '@forage/agent-runtime'
import { discoverMcp } from '@forage/mcp-host'
import { discoverConfiguredMcp, resolveConfiguredMcp } from '@forage/mcp-host/discovery'

// One bounded request per process. No model runtime or model credentials are needed.
for (const name of ['AI_CHAT_API_KEY', 'AI_CHAT_ACCOUNT_ID', 'AI_CHAT_OAUTH_EXPIRES', 'OPENAI_API_KEY', 'OPENAI_ACCESS_TOKEN', 'ANTHROPIC_API_KEY']) delete process.env[name]
let buffer = ''
let started = false
const controller = new AbortController()
process.on('SIGTERM', () => { controller.abort(); setTimeout(() => process.exit(0), 6_000).unref() })
process.stdin.setEncoding('utf8')
process.stdin.on('end', () => controller.abort())
process.stdin.on('data', (chunk: string) => {
  if (started) return
  buffer += chunk
  if (buffer.length > 200_000) { process.exitCode = 1; process.stdin.destroy(); return }
  if (!buffer.includes('\n')) return
  started = true
  void run(buffer.slice(0, buffer.indexOf('\n')))
})
async function run(line: string) {
  try {
    const request = JSON.parse(line) as { action?: unknown; id?: unknown; name?: unknown; config?: unknown; values?: unknown }
    if (request.action === 'scan') {
      const discovery = await discoverConfiguredMcp()
      process.stdout.write(`${JSON.stringify({ ok: true, discovery })}\n`, () => process.exit(0))
      return
    }
    if (request.action === 'resolve') {
      if (typeof request.id !== 'string' || !/^[a-f0-9]{64}$/.test(request.id) || !request.values || typeof request.values !== 'object' || Array.isArray(request.values)
        || Object.values(request.values).some((value) => typeof value !== 'string')) throw new Error('Invalid connection request.')
      const configuration = await resolveConfiguredMcp(request.id, request.values as Record<string, string>)
      process.stdout.write(`${JSON.stringify({ ok: true, configuration })}\n`, () => process.exit(0))
      return
    }
    if (request.action !== undefined && request.action !== 'discover') throw new Error('Unknown operation.')
    if (typeof request.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(request.id)
      || typeof request.name !== 'string' || !request.name || request.name.length > 80) throw new Error('Invalid MCP connection identity.')
    const config = mcpServerConfigSchema.parse(request.config)
    const connection = await discoverMcp({ id: request.id, name: request.name, environment: 'local' }, config, controller.signal)
    process.stdout.write(`${JSON.stringify({ ok: true, connection })}\n`, () => process.exit(0))
  } catch (error) {
    const detail = error instanceof Error && error.message.startsWith('MCP:') ? error.message : 'Invalid MCP configuration or connection cancelled.'
    process.stdout.write(`${JSON.stringify({ ok: false, error: detail })}\n`, () => process.exit(1))
  }
}
