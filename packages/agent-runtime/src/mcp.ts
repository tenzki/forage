import { z } from 'zod'

export const MCP_MAX_TOOLS = 256
export const MCP_MAX_SCHEMA_BYTES = 32_000
const identifier = z.string().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
const strings = z.record(z.string().min(1).max(128), z.string().max(20_000))
  .refine((value) => Object.keys(value).length <= 64, 'Too many configuration values')

const endpoint = z.string().url().max(2_000).refine((value) => {
  const url = new URL(value)
  return !url.username && !url.password && !url.hash && !url.search
    && (url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
}, 'Use HTTPS, or HTTP on localhost, without credentials, a query, or a fragment')

export const mcpHttpAuthenticationSchema = z.union([
  z.object({ method: z.enum(['manual', 'none']) }).strict(),
  z.object({
    method: z.literal('oauth'),
    clientId: z.string().min(1).max(2_000).optional(),
    clientMetadataUrl: z.string().url().max(2_000).refine((value) => {
      const url = new URL(value)
      return url.protocol === 'https:' && !url.username && !url.password && !url.hash && url.pathname !== '/'
    }).optional(),
  }).strict().refine((value) => !value.clientId || !value.clientMetadataUrl, 'Choose one public-client registration method'),
])

export const mcpServerConfigSchema = z.union([
  z.object({
    command: z.string().trim().min(1).max(2_000),
    args: z.array(z.string().max(4_000)).max(64).default([]),
    env: strings.default({}),
    cwd: z.string().min(1).max(2_000).optional(),
    type: z.literal('stdio').optional(),
  }).strict(),
  z.object({
    url: endpoint,
    headers: strings.refine((headers) => Object.keys(headers).every((key) => /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key))
      && Object.values(headers).every((value) => !/[\r\n]/.test(value)), 'Invalid HTTP headers').default({}),
    type: z.enum(['http', 'streamable-http']).optional(),
    authentication: mcpHttpAuthenticationSchema.optional(),
  }).strict().refine((config) => !['oauth', 'none'].includes(config.authentication?.method ?? '')
    || !Object.keys(config.headers).some((key) => key.toLowerCase() === 'authorization'), 'Authentication method conflicts with Authorization header'),
])
export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>

export const mcpImportSchema = z.object({ mcpServers: z.record(identifier, mcpServerConfigSchema)
  .refine((servers) => Object.keys(servers).length > 0 && Object.keys(servers).length <= 32, 'Provide between 1 and 32 servers') }).strict()

export function validateMcpInputSchema(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if ((value as Record<string, unknown>).type !== 'object') return false
  let serialized: string
  try { serialized = JSON.stringify(value) } catch { return false }
  if (serialized.length > MCP_MAX_SCHEMA_BYTES) return false
  const visit = (node: unknown, depth: number): boolean => {
    if (depth > 20) return false
    if (!node || typeof node !== 'object') return true
    if (Array.isArray(node)) return node.every((child) => visit(child, depth + 1))
    return Object.entries(node).every(([key, child]) => {
      if (key === '$ref') return typeof child === 'string' && child.startsWith('#/')
      if (key === '$dynamicRef' || key === '$recursiveRef') return false
      return visit(child, depth + 1)
    })
  }
  return visit(value, 0)
}

export const mcpToolSchema = z.object({
  id: z.string().regex(/^mcp_[ls]_[a-f0-9]{48}$/),
  remoteName: z.string().min(1).max(256),
  name: z.string().min(1).max(256),
  description: z.string().max(8_000),
  inputSchema: z.custom<Record<string, unknown>>(validateMcpInputSchema, 'Unsupported or oversized MCP input schema'),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  bindingFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict()
export type McpTool = z.infer<typeof mcpToolSchema>

export const mcpConnectionSchema = z.object({
  id: identifier,
  name: z.string().trim().min(1).max(80),
  environment: z.enum(['local', 'server']),
  enabled: z.boolean(),
  tools: z.array(mcpToolSchema).max(MCP_MAX_TOOLS),
  error: z.string().max(500).optional(),
  discoveryId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  authentication: z.enum(['manual', 'none', 'oauth']).optional(),
  authorizationStatus: z.enum(['connected', 'sign_in_required', 'review_required']).optional(),
  authorizationRevision: z.string().uuid().optional(),
}).strict().refine((connection) => connection.environment === 'local' || connection.authentication !== 'oauth', 'Desktop OAuth is local only')
  .refine((connection) => !connection.authorizationStatus || connection.authentication === 'oauth', 'Authorization status requires OAuth')
  .refine((connection) => connection.authentication !== 'oauth' || !!connection.authorizationStatus, 'OAuth authorization status is required')
export type McpConnection = z.infer<typeof mcpConnectionSchema>

export function retainMcpToolIds(previous: McpConnection, next: McpConnection): McpConnection {
  if (previous.id !== next.id || previous.environment !== next.environment) return next
  return { ...next, tools: next.tools.map((tool) => {
    const saved = previous.tools.find((candidate) => candidate.remoteName === tool.remoteName)
    return saved && (!saved.bindingFingerprint || saved.bindingFingerprint === tool.bindingFingerprint)
      ? { ...tool, id: saved.id } : tool
  }) }
}
export const mcpCandidateSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  name: z.string().min(1).max(80),
  sources: z.array(z.string().max(80)).min(1).max(8),
  transport: z.enum(['stdio', 'http']),
  inputs: z.array(z.object({ key: z.string().max(150), label: z.string().max(180) }).strict()).max(64),
  issue: z.string().max(500).optional(),
}).strict()
export type McpCandidate = z.infer<typeof mcpCandidateSchema>
export const mcpDiscoverySchema = z.object({
  candidates: z.array(mcpCandidateSchema).max(100),
  warnings: z.array(z.string().max(300)).max(16),
}).strict()
export type McpDiscovery = z.infer<typeof mcpDiscoverySchema>
export const mcpCandidateConfigurationSchema = z.object({ name: z.string().min(1).max(80), config: mcpServerConfigSchema }).strict()
export const mcpInventorySchema = z.array(mcpConnectionSchema).max(32)

/** Only public metadata belongs in durable run inputs. Configuration is resolved at execution. */
export const mcpSnapshotSchema = z.array(mcpConnectionSchema).max(32)
export type McpSnapshot = z.infer<typeof mcpSnapshotSchema>
export const mcpRunConnectionsSchema = z.array(z.object({
  connection: mcpConnectionSchema,
  config: mcpServerConfigSchema,
}).strict().refine(({ connection, config }) => !('url' in config) || config.authentication?.method !== 'oauth' || connection.environment === 'local', 'Desktop OAuth is local only')
  .refine(({ connection, config }) => !connection.authentication || 'url' in config && config.authentication?.method === connection.authentication, 'MCP authentication binding changed')).max(32)
export type McpRunConnection = z.infer<typeof mcpRunConnectionsSchema>[number]

export function selectMcpSnapshot(connections: readonly McpConnection[], toolIds: readonly string[]): McpSnapshot {
  const allowed = new Set(toolIds)
  return connections.filter(mcpConnectionAvailable).flatMap((connection) => {
    const tools = connection.tools.filter((tool) => allowed.has(tool.id))
    return tools.length ? [{ ...connection, tools }] : []
  })
}

export function mcpConnectionAvailable(connection: McpConnection): boolean {
  return connection.enabled && !connection.error && (!connection.authorizationStatus || connection.authorizationStatus === 'connected')
}

export function hasMcpTools(toolIds: readonly string[]): boolean {
  return toolIds.some((id) => /^mcp_[ls]_/.test(id))
}
