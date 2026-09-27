import { createHash } from 'node:crypto'
import { Client, StreamableHTTPClientTransport, type CallToolResult, type Transport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import {
  AgentRuntimeError, MCP_MAX_TOOLS, mcpConnectionSchema, mcpServerConfigSchema, mcpToolSchema,
  type McpConnection, type McpRunConnection, type McpServerConfig, type McpTool, type RuntimeTool,
} from '@forage/agent-runtime'

const MAX_MESSAGE_BYTES = 2_000_000
const MAX_RESULT_CHARS = 40_000
const CONNECT_TIMEOUT = 20_000
const CALL_TIMEOUT = 60_000

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

function digest(value: unknown): string { return createHash('sha256').update(canonicalJson(value)).digest('hex') }

export function mcpToolId(environment: 'local' | 'server', connectionId: string, remoteName: string, fingerprint: string): string {
  return `mcp_${environment === 'local' ? 'l' : 's'}_${digest([connectionId, remoteName, fingerprint]).slice(0, 48)}`
}

export function mcpSecretValues(config: McpServerConfig): string[] {
  return Object.values('command' in config ? config.env : config.headers).filter((value) => value.length > 2)
}

function redact(text: string, secrets: readonly string[]): string {
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) text = text.split(secret).join('[redacted]')
  return text.replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
}

/** Never inherit the sidecar's model credentials or the backend's database/encryption secrets. */
export function mcpChildEnvironment(configured: Record<string, string>, environment = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'WINDIR', 'LANG']) {
    if (environment[key]) env[key] = environment[key]!
  }
  return { ...env, ...configured }
}

/** Do not follow redirects with configured headers; bound streamed JSON/SSE before the SDK buffers it. */
export const boundedMcpFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, { ...init, redirect: 'error' })
  if (!response.body) return response
  const reader = response.body.getReader()
  let bytes = 0
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read()
        if (next.done) { controller.close(); return }
        bytes += next.value.byteLength
        if (bytes > MAX_MESSAGE_BYTES) {
          await reader.cancel()
          controller.error(new Error('MCP response exceeds the size limit.'))
          return
        }
        controller.enqueue(next.value)
      } catch (error) { controller.error(error) }
    },
    cancel: (reason) => reader.cancel(reason),
  })
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
}

export interface McpSession {
  tools: McpTool[]
  call: (tool: McpTool, input: Record<string, unknown>, signal: AbortSignal) => Promise<string>
  close: () => Promise<void>
}

export async function connectMcp(
  identity: Pick<McpConnection, 'id' | 'name' | 'environment'>,
  rawConfig: McpServerConfig,
  signal: AbortSignal,
): Promise<McpSession> {
  const config = mcpServerConfigSchema.parse(rawConfig)
  const secrets = mcpSecretValues(config)
  signal.throwIfAborted()
  const client = new Client({ name: 'forage', version: '0.1.0' }, {
    capabilities: {}, listMaxPages: 16,
    versionNegotiation: { mode: 'auto', probe: { timeoutMs: 2_000, maxRetries: 0 } },
  })
  let transport: Transport
  if ('command' in config) {
    const stdio = new StdioClientTransport({
      command: config.command, args: config.args, env: mcpChildEnvironment(config.env),
      ...(config.cwd ? { cwd: config.cwd } : {}), stderr: 'pipe', maxBufferSize: MAX_MESSAGE_BYTES,
    })
    // Drain without retaining or logging potentially sensitive subprocess output.
    stdio.stderr?.on('data', () => undefined)
    transport = stdio
  } else {
    transport = new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers: config.headers }, fetch: boundedMcpFetch,
      onInsufficientScope: 'throw',
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1_000, maxReconnectionDelay: 1_000, reconnectionDelayGrowFactor: 1 },
    })
  }
  let closed = false
  let closing: Promise<void> | undefined
  const close = (): Promise<void> => {
    if (closing) return closing
    closed = true
    signal.removeEventListener('abort', onAbort)
    closing = (async () => {
      await client.close().catch(() => undefined)
      await transport.close().catch(() => undefined)
    })()
    return closing
  }
  const onAbort = () => { void close() }
  signal.addEventListener('abort', onAbort, { once: true })
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(CONNECT_TIMEOUT)])
  try {
    await client.connect(transport, { signal: deadline, timeout: CONNECT_TIMEOUT })
    deadline.throwIfAborted()
    const listed = await client.listTools({}, { signal: deadline, timeout: CONNECT_TIMEOUT })
    if (listed.tools.length > MCP_MAX_TOOLS) throw new Error('Too many MCP tools')
    const names = new Set<string>()
    const tools = listed.tools.map((tool) => {
      if (names.has(tool.name)) throw new Error('Duplicate MCP tool name')
      names.add(tool.name)
      const binding = 'command' in config ? { command: config.command, args: config.args, cwd: config.cwd ?? '' } : { url: config.url }
      const definition = { name: tool.name, title: tool.title ?? tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema, binding }
      const fingerprint = digest(definition)
      return mcpToolSchema.parse({
        id: mcpToolId(identity.environment, identity.id, tool.name, fingerprint), remoteName: tool.name,
        name: redact(tool.title ?? tool.name, secrets), description: redact(tool.description ?? '', secrets),
        inputSchema: tool.inputSchema, fingerprint,
      })
    })
    if (JSON.stringify(tools).length > 250_000) throw new Error('MCP tool inventory exceeds the size limit')
    signal.throwIfAborted()
    return {
      tools, close,
      async call(tool, input, callSignal) {
        const combined = AbortSignal.any([signal, callSignal, AbortSignal.timeout(CALL_TIMEOUT)])
        combined.throwIfAborted()
        if (closed) throw new Error('MCP connection is closed. Refresh the connection and retry explicitly.')
        if (!tools.some((candidate) => candidate.id === tool.id && candidate.fingerprint === tool.fingerprint)) {
          throw new Error('MCP tool is not admitted for this connection.')
        }
        try {
          const result = await client.callTool({ name: tool.remoteName, arguments: input }, { signal: combined, timeout: CALL_TIMEOUT })
          const output = redact(mcpResultText(result), secrets)
          if (result.isError) throw new McpToolError(output)
          return output
        } catch (error) {
          combined.throwIfAborted()
          if (error instanceof McpToolError) throw error
          throw new Error('MCP tool call failed. It was not retried; external changes may already have occurred. Check the server and connection.')
        }
      },
    }
  } catch (error) {
    await close()
    signal.throwIfAborted()
    const detail = error instanceof Error ? error.message : ''
    const reason = /401|403|auth|unauthorized/i.test(detail) ? 'Authentication failed. Check the configured headers or environment.'
      : /ENOENT|not found/i.test(detail) ? 'Command not found. Install the required runtime or use an absolute executable path.'
        : /timeout|timed out|abort/i.test(detail) ? 'Connection timed out.'
          : /schema|tool|validation/i.test(detail) ? 'The server returned an unsupported, changed, or oversized tool inventory.'
            : 'Connection failed. Check the command or URL and server availability.'
    throw new Error(`MCP: ${reason}`)
  }
}

class McpToolError extends Error {}

export function mcpResultText(result: CallToolResult): string {
  const blocks: string[] = []
  if (result.structuredContent !== undefined) blocks.push(JSON.stringify(result.structuredContent))
  for (const content of result.content ?? []) {
    if (content.type === 'text') blocks.push(content.text)
    else blocks.push(`[MCP ${content.type} content is not supported in this version.]`)
  }
  return blocks.join('\n').slice(0, MAX_RESULT_CHARS) || '(No text returned.)'
}

export async function discoverMcp(identity: Pick<McpConnection, 'id' | 'name' | 'environment'>, config: McpServerConfig, signal = new AbortController().signal): Promise<McpConnection> {
  const session = await connectMcp(identity, config, signal)
  try { return mcpConnectionSchema.parse({ ...identity, enabled: true, tools: session.tools }) }
  finally { await session.close() }
}

export async function openMcpTools(
  connections: readonly McpRunConnection[], allowedToolIds: readonly string[], signal: AbortSignal,
): Promise<{ tools: RuntimeTool[]; close: () => Promise<void> }> {
  const sessions: McpSession[] = []
  const tools: RuntimeTool[] = []
  const allowed = new Set(allowedToolIds)
  const ids = new Set<string>()
  const close = async () => { await Promise.allSettled(sessions.map((session) => session.close())) }
  try {
    for (const { connection, config } of connections) {
      const admitted = connection.tools.filter((tool) => allowed.has(tool.id))
      if (!admitted.length) continue
      if (!connection.enabled || connection.error) throw new Error('MCP connection is unavailable.')
      const session = await connectMcp(connection, config, signal)
      sessions.push(session)
      for (const tool of admitted) {
        if (ids.has(tool.id)) throw new Error('Duplicate MCP tool identity.')
        ids.add(tool.id)
        const discovered = session.tools.find((candidate) => candidate.id === tool.id)
        if (!discovered || discovered.fingerprint !== tool.fingerprint || canonicalJson(discovered.inputSchema) !== canonicalJson(tool.inputSchema)) {
          throw new Error('MCP tools changed. Refresh the connection and review its tools before retrying.')
        }
        tools.push({ id: tool.id, name: `${connection.name} · ${tool.name}`, description: tool.description,
          inputSchema: tool.inputSchema, execute: (input, callSignal) => session.call(discovered, input, callSignal) })
      }
    }
    for (const id of allowed) if (/^mcp_[ls]_/.test(id) && !ids.has(id)) throw new Error('An admitted MCP tool is unavailable. Refresh its connection.')
    return { tools, close }
  } catch (error) {
    await close()
    signal.throwIfAborted()
    throw new AgentRuntimeError('mcp_unavailable', error instanceof Error ? error.message : 'MCP is unavailable.')
  }
}
