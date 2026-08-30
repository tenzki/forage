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
})
