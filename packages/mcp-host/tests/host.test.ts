import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { mcpImportSchema, validateMcpInputSchema, type McpServerConfig } from '@forage/agent-runtime'
import { connectMcp, discoverMcp, mcpChildEnvironment, mcpResultText, mcpToolId, openMcpTools } from '../src/index'

const identity = { id: 'test', name: 'My server', environment: 'local' as const }
const config: McpServerConfig = { command: process.execPath, args: [fileURLToPath(new URL('./fixture.mjs', import.meta.url))], env: { MCP_FIXTURE_STDIO: '1' } }
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { await Promise.allSettled(cleanup.splice(0).map((close) => close())) })

describe('MCP connections', () => {
  it('waits for subprocess cleanup even when cancellation has already started closing it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forage-mcp-process-'))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const pidFile = join(root, 'pid')
    const controller = new AbortController()
    const session = await connectMcp(identity, { ...config, env: { MCP_FIXTURE_STDIO: '1', PID_FILE: pidFile, CLOSE_DELAY: '100' } }, controller.signal)
    cleanup.push(session.close)
    const pid = Number(await readFile(pidFile, 'utf8'))
    controller.abort()
    await session.close()
    expect(() => process.kill(pid, 0)).toThrow()
  })
  it('discovers arbitrary stdio tools and forwards only authorized tools with their schemas', async () => {
    const connection = await discoverMcp(identity, config)
    expect(connection.tools).toHaveLength(3)
    expect(connection.tools[0]!.remoteName).toBe('echo.with-punctuation')
    const tool = connection.tools[0]!
    const run = await openMcpTools([{ connection, config }], [tool.id], new AbortController().signal)
    cleanup.push(run.close)
    expect(run.tools).toHaveLength(1)
    expect(run.tools[0]!.inputSchema).toMatchObject({ required: ['message'] })
    expect(await run.tools[0]!.execute({ message: 'hello' }, new AbortController().signal)).toContain('hello')
    expect(run.tools[0]!.id).toMatch(/^mcp_l_[a-f0-9]{48}$/)
  })

  it('does not start servers with no admitted tools and rejects missing or changed definitions', async () => {
    const connection = await discoverMcp(identity, config)
    const none = await openMcpTools([{ connection, config: { command: '/does/not/exist', args: [], env: {} } }], [], new AbortController().signal)
    expect(none.tools).toEqual([])
    const tool = connection.tools[0]!
    await expect(openMcpTools([{ connection, config: { ...config, env: { ...('env' in config ? config.env : {}), DESCRIPTION: 'Changed schema description' } } }], [tool.id], new AbortController().signal))
      .rejects.toThrow('MCP tools changed')
    await expect(openMcpTools([], [tool.id], new AbortController().signal)).rejects.toThrow('unavailable')
  })

  it('preserves failures, redacts configured secrets, and cancels outstanding calls', async () => {
    const session = await connectMcp(identity, { ...config, env: { MCP_FIXTURE_STDIO: '1', SECRET: 'secret-token' } }, new AbortController().signal)
    cleanup.push(session.close)
    expect(await session.call(session.tools[0]!, { message: 'secret-token' }, new AbortController().signal)).not.toContain('secret-token')
    await expect(session.call(session.tools[1]!, {}, new AbortController().signal)).rejects.toThrow('Fixture rejected')
    const controller = new AbortController()
    const pending = session.call(session.tools[2]!, {}, controller.signal)
    controller.abort()
    await expect(pending).rejects.toThrow()
    await session.close()
    await expect(session.call(session.tools[0]!, { message: 'after close' }, new AbortController().signal)).rejects.toThrow('closed')
  })

  it('connects to a remote HTTP server with configured headers', async () => {
    const requests: string[] = []
    const server = createServer(async (request, response) => {
      requests.push(request.headers.authorization ?? '')
      if (request.method !== 'POST') { response.writeHead(405); response.end(); return }
      let body = ''
      for await (const chunk of request) body += chunk
      const rpc = JSON.parse(body) as { id?: number; method: string; params?: { name: string; arguments: { message: string } } }
      if (rpc.id === undefined) { response.writeHead(202); response.end(); return }
      const result = rpc.method === 'initialize'
        ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'http', version: '1' } }
        : rpc.method === 'tools/list' ? { tools: [{ name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: { message: { type: 'string' } } } }] }
          : rpc.method === 'tools/call' ? { content: [{ type: 'text', text: rpc.params!.arguments.message }] } : undefined
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, ...(result ? { result } : { error: { code: -32601, message: 'Method not found' } }) }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }))
    const address = server.address() as { port: number }
    const session = await connectMcp(identity, { url: `http://127.0.0.1:${address.port}/mcp`, headers: { Authorization: 'Bearer fixture-token' } }, new AbortController().signal)
    cleanup.push(session.close)
    expect(await session.call(session.tools[0]!, { message: 'over HTTP' }, new AbortController().signal)).toBe('over HTTP')
    expect(requests.every((value) => value === 'Bearer fixture-token')).toBe(true)
  })

  it('keeps environment secrets out of subprocesses and validates configuration and schemas', () => {
    expect(mcpChildEnvironment({ EXPLICIT_TOKEN: 'allowed' }, { PATH: '/bin', AI_CHAT_API_KEY: 'no', DATABASE_URL: 'no', HOME: '/home/test' }))
      .toEqual({ PATH: '/bin', HOME: '/home/test', EXPLICIT_TOKEN: 'allowed' })
    expect(mcpImportSchema.safeParse({ mcpServers: { test: { url: 'http://example.com', headers: {} } } }).success).toBe(false)
    expect(validateMcpInputSchema({ type: 'object', properties: { value: { $ref: 'https://example.com/schema' } } })).toBe(false)
    expect(validateMcpInputSchema({ type: 'object', properties: { value: { type: 'string' } } })).toBe(true)
    expect(mcpToolId('local', 'one', 'echo', 'revision')).not.toBe(mcpToolId('server', 'one', 'echo', 'revision'))
    expect(mcpToolId('local', 'one', 'echo', 'revision')).not.toBe(mcpToolId('local', 'one', 'echo', 'changed'))
    expect(mcpResultText({ content: [{ type: 'text', text: 'x'.repeat(90_000) }] })).toHaveLength(40_000)
  })
})
