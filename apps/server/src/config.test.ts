// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { loadServerConfig, publicConfigForLogging } from './config'

describe('server configuration', () => {
  it('validates PostgreSQL, origin, filesystem, and compatibility settings', () => {
    const config = loadServerConfig({
      DATABASE_URL: 'postgres://forage:secret@localhost:5432/forage',
      FORAGE_INSTANCE_ID: 'instance-1',
      FORAGE_ASSET_DIR: '/var/lib/forage/assets',
      FORAGE_HOST: '127.0.0.1',
      FORAGE_PORT: '3210',
    })
    expect(config.port).toBe(3210)
    expect(publicConfigForLogging(config)).not.toContain('secret')
  })

  it('refuses to start without required durable storage configuration', () => {
    expect(() => loadServerConfig({})).toThrow(/DATABASE_URL|database/i)
  })

  it('loads bounded worker/provider settings and keeps encryption secrets out of logs', () => {
    const key = Buffer.alloc(32, 9).toString('base64')
    const config = loadServerConfig({
      DATABASE_URL: 'postgres://forage:secret@localhost:5432/forage',
      FORAGE_INSTANCE_ID: 'instance-1',
      FORAGE_ASSET_DIR: '/tmp/assets',
      FORAGE_AGENT_WORKER_ENABLED: 'true',
      FORAGE_AGENT_ENCRYPTION_KEY: `4:${key}`,
      FORAGE_AGENT_WORKER_CONCURRENCY: '3',
      FORAGE_AGENT_LEASE_SECONDS: '45',
      FORAGE_AGENT_MAX_ATTEMPTS: '4',
      FORAGE_SUPADATA_API_URL: 'https://api.supadata.ai/v1',
      FORAGE_SUPADATA_API_KEY: 'transcript-secret',
    })
    expect(config.agent.worker).toMatchObject({ enabled: true, concurrency: 3, leaseSeconds: 45, maxAttempts: 4 })
    expect(config.agent.encryptionKeys[0]?.version).toBe(4)
    const logged = publicConfigForLogging(config)
    expect(logged).not.toContain(key)
    expect(logged).not.toContain('transcript-secret')
    expect(logged).toContain('"workerEnabled":true')
  })

  it('requires a valid external encryption key when the worker is enabled', () => {
    const base = {
      DATABASE_URL: 'postgres://localhost/forage', FORAGE_INSTANCE_ID: 'instance-1', FORAGE_ASSET_DIR: '/tmp/assets',
      FORAGE_AGENT_WORKER_ENABLED: 'true',
    }
    expect(() => loadServerConfig(base)).toThrow(/encryption/i)
    expect(() => loadServerConfig({ ...base, FORAGE_AGENT_ENCRYPTION_KEY: '1:not-base64' })).toThrow(/encryption/i)
  })
})
