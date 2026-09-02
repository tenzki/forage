import { z } from 'zod'

const environmentSchema = z.object({
  DATABASE_URL: z.string().url().startsWith('postgres'),
  FORAGE_INSTANCE_ID: z.string().trim().min(1).max(128),
  FORAGE_ASSET_DIR: z.string().trim().min(1),
  FORAGE_HOST: z.string().trim().min(1).default('127.0.0.1'),
  FORAGE_PORT: z.coerce.number().int().min(1).max(65_535).default(3210),
  FORAGE_AGENT_WORKER_ENABLED: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  FORAGE_AGENT_ENCRYPTION_KEY: z.string().trim().optional(),
  FORAGE_AGENT_PREVIOUS_ENCRYPTION_KEYS: z.string().trim().optional(),
  FORAGE_AGENT_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
  FORAGE_AGENT_POLL_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
  FORAGE_AGENT_LEASE_SECONDS: z.coerce.number().int().min(15).max(900).default(60),
  FORAGE_AGENT_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(3),
  FORAGE_AGENT_MAX_BACKOFF_SECONDS: z.coerce.number().int().min(1).max(86_400).default(300),
  FORAGE_OAUTH_DEVICE_URL: z.string().url().default('https://auth.openai.com/api/accounts/deviceauth/usercode'),
  FORAGE_OAUTH_TOKEN_URL: z.string().url().default('https://auth.openai.com/oauth/token'),
  FORAGE_OAUTH_CLIENT_ID: z.string().trim().min(1).max(500).optional(),
  FORAGE_OAUTH_TIMEOUT_SECONDS: z.coerce.number().int().min(30).max(1_800).default(600),
  FORAGE_SUPADATA_API_URL: z.string().url().optional(),
  FORAGE_SUPADATA_API_KEY: z.string().trim().min(1).max(2_000).optional(),
}).passthrough()

export interface AgentEncryptionKey { version: number; keyBase64: string }

export interface ServerConfig {
  databaseUrl: string
  instanceId: string
  assetDir: string
  host: string
  port: number
  agent: {
    worker: { enabled: boolean; concurrency: number; pollMs: number; leaseSeconds: number; maxAttempts: number; maxBackoffSeconds: number }
    encryptionKeys: AgentEncryptionKey[]
    oauth: { deviceUrl: string; tokenUrl: string; timeoutSeconds: number; clientId: string | null }
    supadata: { apiUrl: string; apiKey: string } | null
  }
}

function encryptionKey(value: string): AgentEncryptionKey {
  const match = /^(\d+):([A-Za-z0-9+/]+={0,2})$/.exec(value)
  const version = Number(match?.[1])
  const keyBase64 = match?.[2] ?? ''
  if (!Number.isInteger(version) || version < 1 || Buffer.from(keyBase64, 'base64').length !== 32
    || Buffer.from(keyBase64, 'base64').toString('base64') !== keyBase64) {
    throw new Error('Agent credential encryption key must be VERSION:BASE64 with a 32-byte key.')
  }
  return { version, keyBase64 }
}

export function loadServerConfig(environment: Record<string, string | undefined>): ServerConfig {
  const value = environmentSchema.parse(environment)
  const encryptionKeys = [value.FORAGE_AGENT_ENCRYPTION_KEY, ...(value.FORAGE_AGENT_PREVIOUS_ENCRYPTION_KEYS?.split(',') ?? [])]
    .filter((candidate): candidate is string => Boolean(candidate))
    .map(encryptionKey)
  if (new Set(encryptionKeys.map((key) => key.version)).size !== encryptionKeys.length) {
    throw new Error('Agent credential encryption key versions must be unique.')
  }
  if (value.FORAGE_AGENT_WORKER_ENABLED && encryptionKeys.length === 0) {
    throw new Error('Agent credential encryption key is required when the server worker is enabled.')
  }
  if (Boolean(value.FORAGE_SUPADATA_API_URL) !== Boolean(value.FORAGE_SUPADATA_API_KEY)) {
    throw new Error('Supadata API URL and API key must be configured together.')
  }
  return {
    databaseUrl: value.DATABASE_URL,
    instanceId: value.FORAGE_INSTANCE_ID,
    assetDir: value.FORAGE_ASSET_DIR,
    host: value.FORAGE_HOST,
    port: value.FORAGE_PORT,
    agent: {
      worker: {
        enabled: value.FORAGE_AGENT_WORKER_ENABLED,
        concurrency: value.FORAGE_AGENT_WORKER_CONCURRENCY,
        pollMs: value.FORAGE_AGENT_POLL_MS,
        leaseSeconds: value.FORAGE_AGENT_LEASE_SECONDS,
        maxAttempts: value.FORAGE_AGENT_MAX_ATTEMPTS,
        maxBackoffSeconds: value.FORAGE_AGENT_MAX_BACKOFF_SECONDS,
      },
      encryptionKeys,
      oauth: {
        deviceUrl: value.FORAGE_OAUTH_DEVICE_URL,
        tokenUrl: value.FORAGE_OAUTH_TOKEN_URL,
        timeoutSeconds: value.FORAGE_OAUTH_TIMEOUT_SECONDS,
        clientId: value.FORAGE_OAUTH_CLIENT_ID ?? null,
      },
      supadata: value.FORAGE_SUPADATA_API_URL && value.FORAGE_SUPADATA_API_KEY
        ? { apiUrl: value.FORAGE_SUPADATA_API_URL, apiKey: value.FORAGE_SUPADATA_API_KEY }
        : null,
    },
  }
}

export function publicConfigForLogging(config: ServerConfig): string {
  const database = new URL(config.databaseUrl)
  return JSON.stringify({
    instanceId: config.instanceId,
    assetDir: config.assetDir,
    host: config.host,
    port: config.port,
    database: `${database.protocol}//${database.hostname}:${database.port || '5432'}${database.pathname}`,
    workerEnabled: config.agent.worker.enabled,
    workerConcurrency: config.agent.worker.concurrency,
    transcriptProviderConfigured: config.agent.supadata !== null,
    credentialKeyVersions: config.agent.encryptionKeys.map((key) => key.version),
  })
}
