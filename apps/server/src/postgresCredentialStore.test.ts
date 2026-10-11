import { describe, expect, it, vi } from 'vitest'
import type { Pool } from 'pg'
import { PostgresProviderCredentialStore } from './postgresCredentialStore'

describe('Postgres provider account enrollment transaction', () => {
  const now = '2026-09-29T10:00:00.000Z'
  const record = { id: 'new-credential', ownerId: 'owner', outlineId: 'outline', provider: 'anthropic' as const, status: 'connected' as const, encrypted: { ciphertext: 'YWJj', nonce: 'ZGVm', keyVersion: 1 }, createdAt: now, updatedAt: now }

  it('locks the scoped identity and replaces its encrypted credential without changing the active reference', async () => {
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes('SELECT *') ? [{
      id: 'active-reference', owner_id: 'owner', outline_id: 'outline', provider: 'anthropic', status: 'connected',
      ciphertext: Buffer.from('old'), nonce: Buffer.from('nonce'), key_version: 1,
      created_at: new Date('2025-01-01'), updated_at: new Date(now), account_label: null, expires_at: null,
    }] : [] }))
    const release = vi.fn()
    const store = new PostgresProviderCredentialStore({ connect: async () => ({ query, release }) } as unknown as Pool)
    const changed = await store.enroll(record)
    expect(changed.id).toBe('active-reference')
    expect(changed.createdAt).toBe('2025-01-01T00:00:00.000Z')
    expect(query.mock.calls[0]?.[0]).toBe('BEGIN')
    expect(query.mock.calls[1]?.[0]).toContain('pg_advisory_xact_lock')
    expect(query.mock.calls[2]?.[0]).toContain('profile.credential_reference=credential.id')
    expect(query.mock.calls[3]?.[0]).toContain('UPDATE agent_provider_credentials')
    expect(query.mock.calls[4]?.[0]).toBe('COMMIT')
    expect(release).toHaveBeenCalledOnce()
  })

  it('rolls back failed writes and releases the client', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('INSERT')) throw new Error('database write failed')
      return { rows: [] }
    })
    const release = vi.fn()
    const store = new PostgresProviderCredentialStore({ connect: async () => ({ query, release }) } as unknown as Pool)
    await expect(store.enroll(record)).rejects.toThrow('database write failed')
    expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK')
    expect(release).toHaveBeenCalledOnce()
  })
})
