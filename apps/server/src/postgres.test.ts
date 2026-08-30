// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { PostgresServerRepository } from './postgres'
import { parseEventEnvelope } from '@forage/domain'

const connectionString = process.env.TEST_DATABASE_URL ?? 'postgres://forage:forage@127.0.0.1:55437/forage_test'
const pool = new Pool({ connectionString })
const describePostgres = process.env.TEST_DATABASE_URL ? describe : describe.skip

describePostgres('PostgreSQL server repository', () => {
  beforeAll(async () => {
    const migration = await readFile(new URL('../migrations/0001_server.sql', import.meta.url), 'utf8')
    await pool.query(migration)
  })

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE idempotency_records, credentials, note_projections, outline_checkpoints,
        outline_projections, assets, outline_events, outlines, owners RESTART IDENTITY CASCADE
    `)
  })
  it('serializes concurrent note acceptance into contiguous outline revisions', async () => {
    const repository = new PostgresServerRepository(pool, { instanceId: 'instance-test' })
    const bootstrap = await repository.bootstrapOwner('owner@test.invalid')
    const principal = await repository.authenticate(bootstrap.apiToken, 'notes:create')

    const results = await Promise.all([
      repository.createNote(principal, 'key-1', { text: 'First' }),
      repository.createNote(principal, 'key-2', { text: 'Second' }),
    ])

    expect(results.map((result) => result.response.revision).sort()).toEqual([1, 2])
    expect(await repository.currentRevision(bootstrap.outlineId)).toBe(2)
  })

  it('keeps accepted events immutable at the database boundary', async () => {
    const repository = new PostgresServerRepository(pool, { instanceId: 'instance-test' })
    const bootstrap = await repository.bootstrapOwner('owner@test.invalid')
    const principal = await repository.authenticate(bootstrap.apiToken, 'notes:create')
    await repository.createNote(principal, 'key-1', { text: 'Immutable' })

    await expect(pool.query(`UPDATE outline_events SET payload = '{}' WHERE outline_id = $1`, [bootstrap.outlineId]))
      .rejects.toThrow(/immutable/i)
    expect(await repository.currentRevision(bootstrap.outlineId)).toBe(1)
  })

  it('rolls back a stale event batch without advancing revision', async () => {
    const repository = new PostgresServerRepository(pool, { instanceId: 'instance-test' })
    const bootstrap = await repository.bootstrapOwner('owner@test.invalid')
    const api = await repository.authenticate(bootstrap.apiToken, 'notes:create')
    const device = await repository.authenticate(bootstrap.deviceToken, 'sync')
    await repository.createNote(api, 'key-1', { text: 'Remote' })

    await expect(repository.acceptEvents(device, 0, [])).rejects.toThrow(/rebase_required/)
    expect(await repository.currentRevision(bootstrap.outlineId)).toBe(1)
  })

  it('makes duplicate event retries idempotent and rolls back projection failures', async () => {
    const repository = new PostgresServerRepository(pool, { instanceId: 'instance-test' })
    const bootstrap = await repository.bootstrapOwner('owner@test.invalid')
    const device = await repository.authenticate(bootstrap.deviceToken, 'sync')
    const base = {
      outlineId: bootstrap.outlineId, actorId: bootstrap.ownerId, deviceId: 'device-test',
      eventVersion: 1, documentVersion: 1, schemaEpoch: 1, baseRevision: 0,
      origin: 'desktop' as const, occurredAt: '2026-08-30T12:00:00.000Z',
    }
    const valid = parseEventEnvelope({ ...base, id: 'event-once', type: 'shortcut.deleted', payload: { shortcutId: 'missing' } })
    const first = await repository.acceptEvents(device, 0, [valid])
    expect(await repository.acceptEvents(device, 0, [valid])).toEqual(first)
    expect((await pool.query('SELECT count(*)::int AS count FROM outline_events')).rows[0].count).toBe(1)

    const invalid = parseEventEnvelope({
      ...base, id: 'event-invalid', baseRevision: 1, type: 'document.steps_applied',
      payload: { steps: [{ stepType: 'unknown' }], inverseSteps: [{}], beforeHash: 'a'.repeat(64), afterHash: 'b'.repeat(64) },
    })
    await expect(repository.acceptEvents(device, 1, [invalid])).rejects.toThrow()
    expect(await repository.currentRevision(bootstrap.outlineId)).toBe(1)
    expect((await pool.query('SELECT count(*)::int AS count FROM outline_events')).rows[0].count).toBe(1)
  })
})
