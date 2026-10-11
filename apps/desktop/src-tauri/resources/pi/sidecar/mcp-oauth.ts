#!/usr/bin/env node
import { z } from 'zod'
import { mcpOAuthConnectionIdSchema, mcpOAuthCredentialSchema, mcpServerConfigSchema, MCP_OAUTH_TIMEOUT_MS } from '@forage/agent-runtime'
import { authorizeMcp, refreshMcpCredential, revokeMcpCredential, McpOAuthError } from '@forage/mcp-host/oauth'
import { mcpChildEnvironment } from '@forage/mcp-host'

const environment = mcpChildEnvironment({})
for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key]
const requestSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('authorize'), id: mcpOAuthConnectionIdSchema, name: z.string().min(1).max(80), config: mcpServerConfigSchema }).strict(),
  z.object({ action: z.literal('refresh'), credential: mcpOAuthCredentialSchema }).strict(),
  z.object({ action: z.literal('revoke'), credential: mcpOAuthCredentialSchema }).strict(),
])
const controller = new AbortController()
const timer = setTimeout(() => controller.abort(), MCP_OAUTH_TIMEOUT_MS)
const stop = () => { controller.abort(); setTimeout(() => process.exit(1), 1_000).unref() }
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
process.stdin.on('end', stop)
let buffer = ''
let started = false
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk: string) => {
  if (started) return
  buffer += chunk
  if (buffer.length > 150_000) { stop(); return }
  const newline = buffer.indexOf('\n')
  if (newline < 0) return
  started = true
  void run(buffer.slice(0, newline))
  buffer = ''
})
async function run(line: string) {
  let result: unknown
  try {
    const request = requestSchema.parse(JSON.parse(line))
    if (request.action === 'revoke') { await revokeMcpCredential(request.credential, controller.signal); result = { type: 'result', ok: true, credential: request.credential } }
    else if (request.action === 'refresh') result = { type: 'result', ok: true, credential: await refreshMcpCredential(request.credential, controller.signal) }
    else result = { type: 'result', ok: true, ...await authorizeMcp(request, request.config, controller.signal,
      (progress) => process.stdout.write(`${JSON.stringify({ type: 'progress', ...progress })}\n`)) }
  } catch (error) {
    result = { type: 'result', ok: false, reason: error instanceof McpOAuthError ? error.reason : 'failed' }
  }
  clearTimeout(timer)
  process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0))
}
