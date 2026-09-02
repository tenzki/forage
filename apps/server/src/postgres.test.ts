// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PostgresServerRepository } from './postgres'
import { parseEventEnvelope } from '@forage/domain'
import { PostgresProviderCredentialStore } from './postgresCredentialStore'
import { ServerCredentialService } from './credentialService'

const connectionString = process.env.TEST_DATABASE_URL ?? 'postgres://forage:forage@127.0.0.1:55437/forage_test'
const pool = new Pool({ connectionString })
const describePostgres = process.env.TEST_DATABASE_URL ? describe : describe.skip

describePostgres('PostgreSQL server repository', () => {
  beforeAll(async () => {
    for (const filename of ['0001_server.sql', '0002_agent_executor.sql']) {
      await pool.query(await readFile(new URL(`../migrations/${filename}`, import.meta.url), 'utf8'))
    }
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

  it('claims a queued run once across competing workers and recovers an expired lease', async () => {
    const repository = new PostgresServerRepository(pool, { instanceId: 'instance-test' })
    const bootstrap = await repository.bootstrapOwner('owner@test.invalid')
    const device = await repository.authenticate(bootstrap.deviceToken, 'agents:manage')
    const service = new ServerCredentialService(new PostgresProviderCredentialStore(pool), {
      encryptionKeys: [{ version: 1, keyBase64: Buffer.alloc(32, 6).toString('base64') }],
    })
    const credential = await service.enrollApiKey(bootstrap.ownerId, bootstrap.outlineId, 'sk-a-very-long-secret-api-key')
    const configuration = {
      version: 1 as const, revision: 1,
      agents: [{ id: 'agent', name: 'Agent', description: 'Agent', systemPrompt: 'Work.', modelId: 'gpt-5', toolIds: [], credentialRef: credential.id }],
      skills: [{ id: 'skill', label: 'skill', description: 'Skill', systemPrompt: 'Write.', agentId: 'agent', requiredToolIds: [] }],
      customTools: [], globallyEnabledToolIds: [],
    }
    await repository.agentStore.publishConfiguration(bootstrap.outlineId, 0, configuration, device.tokenId)
    await repository.agentStore.admitRun({
      ownerId: bootstrap.ownerId, trigger: 'manual', triggerIdentity: 'manual:1', maxAttempts: 2,
      input: {
        version: 1, runId: 'run-pg', executionMode: 'server', outlineId: bootstrap.outlineId,
        source: { nodeId: bootstrap.inboxId, text: 'Source' }, target: { parentId: bootstrap.inboxId },
        baseRevision: 0, configurationRevision: 1, credentialRef: credential.id,
        agent: configuration.agents[0]!, skill: configuration.skills[0]!, effectiveToolIds: [], prompt: 'Run.', context: [],
      },
    })
    const claimAt = new Date(Date.now() + 1_000)
    const claims = await Promise.all([
      repository.agentStore.claimNext('worker-a', claimAt, 10_000),
      repository.agentStore.claimNext('worker-b', claimAt, 10_000),
    ])
    expect(claims.filter(Boolean)).toHaveLength(1)
    const recovered = await repository.agentStore.claimNext('worker-c', new Date(claimAt.getTime() + 20_000), 1_000)
    expect(recovered).toMatchObject({ id: 'run-pg', attemptCount: 2, leaseOwner: 'worker-c' })
  })

  it('admits Inbox automation in the same idempotent capture transaction', async () => {
    const repository = new PostgresServerRepository(pool, { instanceId: 'instance-test', supportedAgentToolIds: ['youtube_transcript'] })
    const bootstrap = await repository.bootstrapOwner('owner@test.invalid')
    const device = await repository.authenticate(bootstrap.deviceToken, 'agents:manage')
    const service = new ServerCredentialService(new PostgresProviderCredentialStore(pool), {
      encryptionKeys: [{ version: 1, keyBase64: Buffer.alloc(32, 7).toString('base64') }],
    })
    const credential = await service.enrollApiKey(bootstrap.ownerId, bootstrap.outlineId, 'sk-a-very-long-secret-api-key')
    await repository.agentStore.publishConfiguration(bootstrap.outlineId, 0, {
      version: 1, revision: 1,
      agents: [{ id: 'agent', name: 'Agent', description: 'Agent', systemPrompt: 'Work.', modelId: 'gpt-5', toolIds: ['youtube_transcript'], credentialRef: credential.id }],
      skills: [{ id: 'summarize', label: 'summarize', description: 'Summarize', systemPrompt: 'Write.', agentId: 'agent', requiredToolIds: ['youtube_transcript'] }],
      customTools: [], globallyEnabledToolIds: ['youtube_transcript'],
    }, device.tokenId)
    await repository.agentStore.publishAutomation(bootstrap.outlineId, 0, {
      version: 1, revision: 1, enabled: true, policies: [{
        id: 'youtube', name: 'YouTube', enabled: true, priority: 1, match: { urlTypes: ['youtube'] },
        skillIds: ['summarize'], dispatcher: { enabled: false, allowedSkillIds: [] },
      }],
    }, device.tokenId)
    const api = await repository.authenticate(bootstrap.apiToken, 'notes:create')
    const first = await repository.createNote(api, 'capture', { text: 'https://youtu.be/dQw4w9WgXcQ' })
    const replay = await repository.createNote(api, 'capture', { text: 'https://youtu.be/dQw4w9WgXcQ' })
    expect(replay.response).toEqual(first.response)
    expect(await repository.agentStore.listRuns(bootstrap.outlineId, 10)).toHaveLength(1)
  })

  it('serializes rotating OAuth refresh tokens under the credential row lock', async () => {
    const repository = new PostgresServerRepository(pool, { instanceId: 'instance-test' })
    const bootstrap = await repository.bootstrapOwner('owner@test.invalid')
    const jwtPayload = Buffer.from(JSON.stringify({ account_id: 'account-1' })).toString('base64url')
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({
      access_token: `x.${jwtPayload}.y`, refresh_token: 'rotated-refresh', expires_in: 3600,
    }), { status: 200 }))
    const service = new ServerCredentialService(new PostgresProviderCredentialStore(pool), {
      encryptionKeys: [{ version: 1, keyBase64: Buffer.alloc(32, 8).toString('base64') }], fetch,
      oauth: { deviceUrl: 'https://auth.example/device', tokenUrl: 'https://auth.example/token', clientId: 'client' },
    })
    const id = await service.importCodexCredentialForTest(bootstrap.ownerId, bootstrap.outlineId, {
      accessToken: 'expired', refreshToken: 'initial-refresh', accountId: 'account-1', expiresAt: '2020-01-01T00:00:00.000Z',
    })
    const credentials = await Promise.all([
      service.resolve(id, bootstrap.ownerId, bootstrap.outlineId),
      service.resolve(id, bootstrap.ownerId, bootstrap.outlineId),
    ])
    expect(credentials).toHaveLength(2)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('commits agent output against the latest outline revision exactly once and lets cancellation win', async () => {
    const repository = new PostgresServerRepository(pool, { instanceId: 'instance-test' })
    const bootstrap = await repository.bootstrapOwner('owner@test.invalid')
    const service = new ServerCredentialService(new PostgresProviderCredentialStore(pool), {
      encryptionKeys: [{ version: 1, keyBase64: Buffer.alloc(32, 9).toString('base64') }],
    })
    const credential = await service.enrollApiKey(bootstrap.ownerId, bootstrap.outlineId, 'sk-a-very-long-secret-api-key')
    const runInput = (runId: string) => ({
      version: 1 as const, runId, executionMode: 'server' as const, outlineId: bootstrap.outlineId,
      source: { nodeId: bootstrap.inboxId, text: 'Source' }, target: { parentId: bootstrap.inboxId },
      baseRevision: 0, configurationRevision: 1, credentialRef: credential.id,
      agent: { id: 'agent', name: 'Agent', description: 'Agent', systemPrompt: 'Work.', modelId: 'gpt-5', toolIds: [] },
      skill: { id: 'skill', label: 'skill', description: 'Skill', systemPrompt: 'Write.', agentId: 'agent', requiredToolIds: [] },
      effectiveToolIds: [], prompt: 'Run.', context: [],
    })
    await repository.agentStore.admitRun({ input: runInput('run-result'), ownerId: bootstrap.ownerId, trigger: 'manual', triggerIdentity: 'manual:result', maxAttempts: 2 })
    await repository.agentStore.claimNext('worker', new Date(Date.now() + 1_000), 30_000)
    const api = await repository.authenticate(bootstrap.apiToken, 'notes:create')
    await repository.createNote(api, 'concurrent-note', { text: 'Concurrent edit' })
    const structured = { version: 1 as const, nodes: [{ type: 'text' as const, text: 'Agent result' }], sources: [] }
    const first = await repository.commitAgentResult('run-result', 'worker', structured)
    const duplicate = await repository.commitAgentResult('run-result', 'worker', structured)
    expect(first).toEqual({ firstRevision: 2, lastRevision: 2, rootNoteIds: expect.any(Array) })
    expect(duplicate).toEqual(first)
    expect((await repository.eventsAfter(bootstrap.outlineId, 0, 10)).filter((event) => event.origin === 'agent')).toHaveLength(1)

    await repository.agentStore.admitRun({ input: runInput('run-cancel'), ownerId: bootstrap.ownerId, trigger: 'manual', triggerIdentity: 'manual:cancel', maxAttempts: 2 })
    await repository.agentStore.claimNext('worker', new Date(Date.now() + 1_000), 30_000)
    await repository.agentStore.requestCancellation(bootstrap.outlineId, 'run-cancel', new Date())
    await expect(repository.commitAgentResult('run-cancel', 'worker', structured)).rejects.toThrow(/cancellation/i)
    expect(await repository.agentStore.getRun(bootstrap.outlineId, 'run-cancel')).toMatchObject({ status: 'running' })
  })
})
