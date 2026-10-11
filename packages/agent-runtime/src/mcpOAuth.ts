import { z } from 'zod'

export const MCP_OAUTH_TIMEOUT_MS = 300_000
export const mcpOAuthConnectionIdSchema = z.string().min(1).max(80).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
const opaqueObject = z.record(z.string().max(128), z.unknown()).refine((value) => {
  try { return JSON.stringify(value).length <= 32_000 } catch { return false }
}, 'OAuth record exceeds the size limit')
export const mcpOAuthCredentialSchema = z.object({
  resource: z.string().url().max(2_000),
  authorizationResource: z.string().url().max(2_000).optional(),
  issuer: z.string().url().max(2_000),
  clientInformation: opaqueObject,
  discovery: opaqueObject,
  tokens: z.object({
    access_token: z.string().min(1).max(20_000).regex(/^[^\s\r\n]+$/),
    token_type: z.string().regex(/^bearer$/i),
    refresh_token: z.string().min(1).max(20_000).optional(),
    expires_in: z.number().nonnegative().finite().optional(),
    scope: z.string().max(8_000).optional(),
  }).strict(),
  expiresAt: z.number().nonnegative().finite(),
}).strict()
export type McpOAuthCredential = z.infer<typeof mcpOAuthCredentialSchema>
export const mcpOAuthLeaseSchema = z.object({
  generation: z.number().int().nonnegative(),
  version: z.number().int().nonnegative(),
  leaseId: z.string().uuid(),
}).strict()
export type McpOAuthLease = z.infer<typeof mcpOAuthLeaseSchema>
export const mcpOAuthProgressSchema = z.object({
  phase: z.enum(['checking', 'waiting', 'exchanging', 'discovering']),
  authorizationUrl: z.string().url().max(8_000).optional(),
}).strict().refine((value) => !value.authorizationUrl || value.phase === 'waiting')
export type McpOAuthProgress = z.infer<typeof mcpOAuthProgressSchema>
export const mcpOAuthTokenRequestSchema = z.object({
  type: z.literal('mcp_oauth_token_request'),
  requestId: z.string().uuid(),
  connectionId: mcpOAuthConnectionIdSchema,
  resource: z.string().url().max(2_000),
}).strict()
export const mcpOAuthTokenResponseSchema = z.object({
  type: z.literal('mcp_oauth_token_response'),
  requestId: z.string().uuid(),
  accessToken: z.string().min(1).max(20_000).regex(/^[^\s\r\n]+$/).optional(),
}).strict()
export const mcpOAuthRequiredSchema = z.object({
  type: z.literal('mcp_oauth_required'),
  connectionId: mcpOAuthConnectionIdSchema,
}).strict()
