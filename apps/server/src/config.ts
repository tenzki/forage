import { z } from 'zod'

const environmentSchema = z.object({
  DATABASE_URL: z.string().url().startsWith('postgres'),
  FORAGE_INSTANCE_ID: z.string().trim().min(1).max(128),
  FORAGE_ASSET_DIR: z.string().trim().min(1),
  FORAGE_HOST: z.string().trim().min(1).default('127.0.0.1'),
  FORAGE_PORT: z.coerce.number().int().min(1).max(65_535).default(3210),
}).passthrough()

export interface ServerConfig {
  databaseUrl: string
  instanceId: string
  assetDir: string
  host: string
  port: number
}

export function loadServerConfig(environment: Record<string, string | undefined>): ServerConfig {
  const value = environmentSchema.parse(environment)
  return {
    databaseUrl: value.DATABASE_URL,
    instanceId: value.FORAGE_INSTANCE_ID,
    assetDir: value.FORAGE_ASSET_DIR,
    host: value.FORAGE_HOST,
    port: value.FORAGE_PORT,
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
  })
}
