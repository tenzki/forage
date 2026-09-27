// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { assertSupportedNodeVersion, loadServerConfig, publicConfigForLogging } from './config'

describe('server configuration', () => {
  it('validates PostgreSQL, origin, filesystem, and compatibility settings', () => {
    const config = loadServerConfig({
      DATABASE_URL: 'postgres://forage:secret@localhost:5432/forage',
      FORAGE_INSTANCE_ID: 'instance-1',
      FORAGE_ASSET_DIR: '/var/lib/forage/assets',
      FORAGE_HOST: '127.0.0.1',
      FORAGE_PORT: '3210',
      FORAGE_AGENT_ENCRYPTION_KEY: `1:${Buffer.alloc(32, 3).toString('base64')}`,
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
      FORAGE_AGENT_ENCRYPTION_KEY: `4:${key}`,
      FORAGE_AGENT_WORKER_CONCURRENCY: '3',
      FORAGE_AGENT_LEASE_SECONDS: '45',
      FORAGE_AGENT_MAX_ATTEMPTS: '4',
      FORAGE_SUPADATA_API_URL: 'https://api.supadata.ai/v1',
      FORAGE_SUPADATA_API_KEY: 'transcript-secret',
    })
    expect(config.agent.worker).toMatchObject({ concurrency: 3, leaseSeconds: 45, maxAttempts: 4 })
    expect(config.agent.encryptionKeys[0]?.version).toBe(4)
    const logged = publicConfigForLogging(config)
    expect(logged).not.toContain(key)
    expect(logged).not.toContain('transcript-secret')
  })

  it('requires a valid external encryption key because every process executes agent runs', () => {
    const base = {
      DATABASE_URL: 'postgres://localhost/forage', FORAGE_INSTANCE_ID: 'instance-1', FORAGE_ASSET_DIR: '/tmp/assets',
    }
    expect(() => loadServerConfig(base)).toThrow(/encryption/i)
    expect(() => loadServerConfig({ ...base, FORAGE_AGENT_ENCRYPTION_KEY: '1:not-base64' })).toThrow(/encryption/i)
  })

  it('runs agents on Pi by default and accepts legacy as the rollback engine', () => {
    const base = {
      DATABASE_URL: 'postgres://localhost/forage', FORAGE_INSTANCE_ID: 'instance-1', FORAGE_ASSET_DIR: '/tmp/assets',
      FORAGE_AGENT_ENCRYPTION_KEY: `1:${Buffer.alloc(32, 3).toString('base64')}`,
    }
    expect(loadServerConfig(base).agent.engine).toBe('pi')
    const legacy = loadServerConfig({ ...base, FORAGE_AGENT_ENGINE: 'legacy' })
    expect(legacy.agent.engine).toBe('legacy')
    expect(publicConfigForLogging(legacy)).toContain('"agentEngine":"legacy"')
    expect(() => loadServerConfig({ ...base, FORAGE_AGENT_ENGINE: 'openai' })).toThrow(/pi or legacy/)
  })

  it('bounds call transcripts at 2 MB per call and 90 days by default', () => {
    const base = {
      DATABASE_URL: 'postgres://localhost/forage', FORAGE_INSTANCE_ID: 'instance-1', FORAGE_ASSET_DIR: '/tmp/assets',
      FORAGE_AGENT_ENCRYPTION_KEY: `1:${Buffer.alloc(32, 3).toString('base64')}`,
    }
    expect(loadServerConfig(base).agent.conversations).toEqual({ maxBytes: 2 * 1024 * 1024, maxAgeDays: 90 })
    expect(loadServerConfig({
      ...base, FORAGE_AGENT_CONVERSATION_MAX_BYTES: '1048576', FORAGE_AGENT_CONVERSATION_MAX_AGE_DAYS: '30',
    }).agent.conversations).toEqual({ maxBytes: 1_048_576, maxAgeDays: 30 })
    expect(() => loadServerConfig({ ...base, FORAGE_AGENT_CONVERSATION_MAX_AGE_DAYS: '0' })).toThrow()
  })

  it('refuses to start on a Node.js older than the Pi SDK requires', () => {
    expect(() => assertSupportedNodeVersion('22.18.0')).toThrow('Forage server requires Node.js 22.19.0 or newer to run agents; this is Node.js 22.18.0.')
    expect(() => assertSupportedNodeVersion('v20.19.5')).toThrow(/22\.19\.0/)
    expect(() => assertSupportedNodeVersion('18.20.0')).toThrow(/22\.19\.0/)
    for (const version of ['22.19.0', '22.20.1', '24.0.0', 'v26.8.1']) {
      expect(() => assertSupportedNodeVersion(version)).not.toThrow()
    }
    expect(() => assertSupportedNodeVersion()).not.toThrow()
  })
})
