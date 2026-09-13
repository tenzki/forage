// @vitest-environment node
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PostgresServerRepository } from './postgres'
import { requireBoundOutline } from './repository'
import { createInitialOutlineState } from '@forage/domain'
import { repairSystemNodes } from '@forage/document'
import { parseEventEnvelope } from '@forage/domain'
import { PostgresProviderCredentialStore } from './postgresCredentialStore'
import { ServerCredentialService } from './credentialService'

const connectionString = process.env.TEST_DATABASE_URL ?? 'postgres://forage:forage@127.0.0.1:55437/forage_contract_test'

// Every test truncates every table, so pointing this at the development database would
// destroy local outlines, owners, and credentials. Refuse rather than wipe them.
if (process.env.TEST_DATABASE_URL && process.env.TEST_DATABASE_URL === process.env.DATABASE_URL) {
  throw new Error(
    'TEST_DATABASE_URL must not equal DATABASE_URL: these tests TRUNCATE every table. '
    + 'Point TEST_DATABASE_URL at a dedicated database such as forage_contract_test.',
  )
}


const SEED_INBOX_ID = 'note_inbox'
const SEED_OUTLINE_ID = 'outline_seed'

/** The document a freshly seeded outline starts from: Inbox, Daily Notes, one empty bullet. */
function seedDocumentState(ids: { inbox: string; daily: string; bullet: string }) {
  const systemIds = [ids.inbox, ids.daily]
  const repaired = repairSystemNodes({
    type: 'doc',
    content: [{
      type: 'bulletList',
      content: [{
        type: 'listItem',
        attrs: {
          nodeId: ids.bullet, nodeType: 'user', collapsed: false, bulletKind: 'bullet',
          completed: false, systemRole: null, dailyDate: null,
        },
        content: [{ type: 'paragraph' }],
      }],
    }],
  }, () => systemIds.shift()!)
  return createInitialOutlineState(repaired.doc)
}

/** Bootstraps, claims, and seeds so a test starts from a ready outline. */
async function bootstrapSeeded(repository: PostgresServerRepository, email = 'owner@test.invalid') {
  const bootstrap = await repository.bootstrapOwner(email)
  await repository.claimOutline(await repository.authenticate(bootstrap.deviceToken, 'sync'), {
    outlineId: SEED_OUTLINE_ID, name: 'Notes',
  })
  await repository.seedOutline(
    requireBoundOutline(requireBoundOutline(await repository.authenticate(bootstrap.deviceToken, 'sync'))),
    seedDocumentState({ inbox: SEED_INBOX_ID, daily: 'note_daily', bullet: 'note_bullet' }),
  )
  return { ...bootstrap, outlineId: SEED_OUTLINE_ID, inboxId: SEED_INBOX_ID }
}

const pool = new Pool({ connectionString })
const describePostgres = process.env.TEST_DATABASE_URL ? describe : describe.skip

describePostgres('PostgreSQL server repository', () => {
  beforeAll(async () => {
    for (const filename of ['0001_server.sql', '0002_agent_executor.sql', '0003_blank_bootstrap.sql', '0004_authority_and_execution.sql']) {
      await pool.query(await readFile(new URL(`../migrations/${filename}`, import.meta.url), 'utf8'))
    }
  })

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE idempotency_records, credentials, note_projections, outline_checkpoints,
        outline_projections, assets, outline_events, outlines, owners RESTART IDENTITY CASCADE
    `)
  })
  it('allows a claimed outline with no inbox and an unbound credential', async () => {
    await pool.query(`INSERT INTO owners(id, email) VALUES ('owner_1', 'a@b.invalid')`)
    await pool.query(
      `INSERT INTO outlines(id, owner_id, name, api_inbox_id, state)
       VALUES ('outline_1', 'owner_1', 'Notes', NULL, 'seeding')`,
    )
    await pool.query(
      `INSERT INTO credentials(id, owner_id, outline_id, kind, name, secret_hash, scopes)
       VALUES ('token_1', 'owner_1', NULL, 'device', 'desktop', 'hash', ARRAY['sync'])`,
    )
    const outline = await pool.query(`SELECT state, api_inbox_id FROM outlines WHERE id = 'outline_1'`)
    expect(outline.rows[0]).toEqual({ state: 'seeding', api_inbox_id: null })
  })

  it('rejects an unknown outline state', async () => {
    await pool.query(`INSERT INTO owners(id, email) VALUES ('owner_2', 'c@d.invalid')`)
    await expect(pool.query(
      `INSERT INTO outlines(id, owner_id, name, api_inbox_id, state)
       VALUES ('outline_2', 'owner_2', 'Notes', NULL, 'archived')`,
    )).rejects.toThrow()
  })

  it('rejects a ready outline with no inbox', async () => {
    await pool.query(`INSERT INTO owners(id, email) VALUES ('owner_3', 'e@f.invalid')`)
    await expect(pool.query(
      `INSERT INTO outlines(id, owner_id, name, api_inbox_id, state)
       VALUES ('outline_3', 'owner_3', 'Notes', NULL, 'ready')`,
    )).rejects.toThrow()
  })

  it('bootstraps an owner with no outline and unbound tokens', async () => {
    const repository = new PostgresServerRepository(pool, { instanceId: 'instance-test' })
    const result = await repository.bootstrapOwner('owner@test.invalid')
    expect(result).toEqual({
      ownerId: expect.stringMatching(/^owner_/),
      apiToken: expect.stringMatching(/^fg_api_/),
      deviceToken: expect.stringMatching(/^fg_device_/),
    })
    expect((await pool.query('SELECT id FROM outlines')).rowCount).toBe(0)
    expect((await repository.authenticate(result.deviceToken, 'sync')).outlineId).toBeNull()
  })

  it('claims a blank server and binds every credential the owner holds', async () => {
    const repository = new PostgresServerRepository(pool, { instanceId: 'instance-test' })
    const bootstrap = await repository.bootstrapOwner('owner@test.invalid')
    const claim = await repository.claimOutline(
      await repository.authenticate(bootstrap.deviceToken, 'sync'),
      { outlineId: 'outline_claimed', name: 'Notes' },
    )
    expect(claim).toEqual({ outlineId: 'outline_claimed', state: 'seeding' })
    expect((await repository.authenticate(bootstrap.deviceToken, 'sync')).outlineId).toBe('outline_claimed')
    // The capture token must come along, or the notes API could never reach the outline.
    expect((await repository.authenticate(bootstrap.apiToken, 'notes:create')).outlineId).toBe('outline_claimed')
  })

  it('is idempotent when the same credential re-claims the same outline', async () => {
    const repository = new PostgresServerRepository(pool, { instanceId: 'instance-test' })
    const bootstrap = await repository.bootstrapOwner('owner@test.invalid')
    await repository.claimOutline(
      await repository.authenticate(bootstrap.deviceToken, 'sync'),
      { outlineId: 'outline_claimed', name: 'Notes' },
    )
    const again = await repository.claimOutline(
      await repository.authenticate(bootstrap.deviceToken, 'sync'),
      { outlineId: 'outline_claimed', name: 'Notes' },
    )
    expect(again).toEqual({ outlineId: 'outline_claimed', state: 'seeding' })
  })

  it('rejects a claim of a second outline', async () => {
    const repository = new PostgresServerRepository(pool, { instanceId: 'instance-test' })
    const bootstrap = await repository.bootstrapOwner('owner@test.invalid')
    await repository.claimOutline(
      await repository.authenticate(bootstrap.deviceToken, 'sync'),
      { outlineId: 'outline_claimed', name: 'Notes' },
    )
    await expect(repository.claimOutline(
      await repository.authenticate(bootstrap.deviceToken, 'sync'),
      { outlineId: 'outline_other', name: 'Notes' },
    )).rejects.toThrow(/already holds an outline/i)
  })

  it('seeds a claimed outline and derives the inbox from the document', async () => {
    const repository = new PostgresServerRepository(pool, { instanceId: 'instance-test' })
    const bootstrap = await bootstrapSeeded(repository)
    const outline = await pool.query('SELECT state, api_inbox_id FROM outlines WHERE id = $1', [bootstrap.outlineId])
    expect(outline.rows[0]).toEqual({ state: 'ready', api_inbox_id: SEED_INBOX_ID })
    const checkpoint = await repository.checkpoint(bootstrap.outlineId)
    expect(checkpoint.revision).toBe(0)
    const notes = await pool.query('SELECT id FROM note_projections WHERE outline_id = $1', [bootstrap.outlineId])
    expect(notes.rowCount).toBe(3)
  })

  it('admits canonical nodes even when their disposable note row is missing', async () => {
    const repository = new PostgresServerRepository(pool, { instanceId: 'instance-test' })
    const bootstrap = await bootstrapSeeded(repository)
    const principal = requireBoundOutline(await repository.authenticate(bootstrap.deviceToken, 'agents:execute'))
    await pool.query('DELETE FROM note_projections WHERE outline_id=$1 AND id=$2', [bootstrap.outlineId, bootstrap.inboxId])

    await expect(repository.runAdmissionContext(principal, bootstrap.inboxId, bootstrap.inboxId)).resolves.toMatchObject({
      baseRevision: 0,
      sourceText: 'Inbox',
    })
  })

  it('rebuilds a falsely-current but incomplete note projection idempotently', async () => {
    const repository = new PostgresServerRepository(pool, { instanceId: 'instance-test' })
    const bootstrap = await bootstrapSeeded(repository)
    await pool.query('DELETE FROM note_projections WHERE outline_id=$1 AND id=$2', [bootstrap.outlineId, bootstrap.inboxId])
    await pool.query(
      `UPDATE note_projection_status SET source_revision=0,schema_version=1,rebuild_status='ready' WHERE outline_id=$1`,
      [bootstrap.outlineId],
    )

    // Row-count validation detects corruption even when metadata claims the cache is current.
    expect(await repository.reconcileNoteProjections()).toBe(1)
    expect((await pool.query('SELECT id FROM note_projections WHERE outline_id=$1 AND id=$2', [bootstrap.outlineId, bootstrap.inboxId])).rowCount).toBe(1)
    expect(await repository.reconcileNoteProjections()).toBe(0)
  })

  it('is idempotent for an identical re-seed and rejects a different one', async () => {
    const repository = new PostgresServerRepository(pool, { instanceId: 'instance-test' })
    const bootstrap = await bootstrapSeeded(repository)
    const device = requireBoundOutline(await repository.authenticate(bootstrap.deviceToken, 'sync'))
    const identical = seedDocumentState({ inbox: SEED_INBOX_ID, daily: 'note_daily', bullet: 'note_bullet' })
    await expect(repository.seedOutline(device, identical)).resolves.toMatchObject({ revision: 0 })
    const different = seedDocumentState({ inbox: SEED_INBOX_ID, daily: 'note_daily', bullet: 'note_other' })
    await expect(repository.seedOutline(device, different)).rejects.toThrow(/already been seeded/i)
  })

  it('rejects a seed referencing an asset that is not uploaded', async () => {
    const repository = new PostgresServerRepository(pool, { instanceId: 'instance-test' })
    const boot = await repository.bootstrapOwner('owner@test.invalid')
    await repository.claimOutline(
      await repository.authenticate(boot.deviceToken, 'sync'),
      { outlineId: 'outline_assets', name: 'Notes' },
    )
    const device = requireBoundOutline(await repository.authenticate(boot.deviceToken, 'sync'))
    const state = seedDocumentState({ inbox: SEED_INBOX_ID, daily: 'note_daily', bullet: 'note_bullet' })
    const withAsset = JSON.parse(JSON.stringify(state)) as typeof state
    ;(withAsset.doc.content as unknown[]).push({
      type: 'generatedImageItem', attrs: { nodeId: 'note_image', assetId: 'a'.repeat(64), alt: 'x' },
    })
    await expect(repository.seedOutline(device, withAsset)).rejects.toThrow(/not uploaded/i)
  })

  it('refuses outline traffic until the outline is seeded', async () => {
    const repository = new PostgresServerRepository(pool, { instanceId: 'instance-test' })
    const boot = await repository.bootstrapOwner('owner@test.invalid')
    await repository.claimOutline(
      await repository.authenticate(boot.deviceToken, 'sync'),
      { outlineId: 'outline_pending', name: 'Notes' },
    )
    expect(await repository.outlineState('outline_pending')).toBe('seeding')
  })

  it('serializes concurrent note acceptance into contiguous outline revisions', async () => {
    const repository = new PostgresServerRepository(pool, { instanceId: 'instance-test' })
    const bootstrap = await bootstrapSeeded(repository, 'owner@test.invalid')
    const principal = requireBoundOutline(await repository.authenticate(bootstrap.apiToken, 'notes:create'))

    const results = await Promise.all([
      repository.createNote(principal, 'key-1', { text: 'First' }),
      repository.createNote(principal, 'key-2', { text: 'Second' }),
    ])

    expect(results.map((result) => result.response.revision).sort()).toEqual([1, 2])
    expect(await repository.currentRevision(bootstrap.outlineId)).toBe(2)
  })

  it('keeps accepted events immutable at the database boundary', async () => {
    const repository = new PostgresServerRepository(pool, { instanceId: 'instance-test' })
    const bootstrap = await bootstrapSeeded(repository, 'owner@test.invalid')
    const principal = requireBoundOutline(await repository.authenticate(bootstrap.apiToken, 'notes:create'))
    await repository.createNote(principal, 'key-1', { text: 'Immutable' })

    await expect(pool.query(`UPDATE outline_events SET payload = '{}' WHERE outline_id = $1`, [bootstrap.outlineId]))
      .rejects.toThrow(/immutable/i)
    expect(await repository.currentRevision(bootstrap.outlineId)).toBe(1)
  })

  it('rolls back a stale event batch without advancing revision', async () => {
    const repository = new PostgresServerRepository(pool, { instanceId: 'instance-test' })
    const bootstrap = await bootstrapSeeded(repository, 'owner@test.invalid')
    const api = requireBoundOutline(await repository.authenticate(bootstrap.apiToken, 'notes:create'))
    const device = requireBoundOutline(await repository.authenticate(bootstrap.deviceToken, 'sync'))
    await repository.createNote(api, 'key-1', { text: 'Remote' })

    await expect(repository.acceptEvents(device, 0, [])).rejects.toThrow(/rebase_required/)
    expect(await repository.currentRevision(bootstrap.outlineId)).toBe(1)
  })

  it('makes duplicate event retries idempotent and rolls back projection failures', async () => {
    const repository = new PostgresServerRepository(pool, { instanceId: 'instance-test' })
    const bootstrap = await bootstrapSeeded(repository, 'owner@test.invalid')
    const device = requireBoundOutline(await repository.authenticate(bootstrap.deviceToken, 'sync'))
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
    const bootstrap = await bootstrapSeeded(repository, 'owner@test.invalid')
    const device = requireBoundOutline(await repository.authenticate(bootstrap.deviceToken, 'agents:manage'))
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
    const bootstrap = await bootstrapSeeded(repository, 'owner@test.invalid')
    const device = requireBoundOutline(await repository.authenticate(bootstrap.deviceToken, 'agents:manage'))
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
    await repository.agentStore.publishComputeProfile(bootstrap.outlineId, 0, {
      version: 1, revision: 1, provider: 'openai', modelId: 'gpt-5', credentialRef: credential.id,
    }, device.tokenId)
    await repository.agentStore.publishAutomation(bootstrap.outlineId, 0, {
      version: 1, revision: 1, enabled: true, policies: [{
        id: 'youtube', name: 'YouTube', enabled: true, priority: 1, match: { urlTypes: ['youtube'] },
        skillIds: ['summarize'], dispatcher: { enabled: false, allowedSkillIds: [] },
      }],
    }, device.tokenId)
    const api = requireBoundOutline(await repository.authenticate(bootstrap.apiToken, 'notes:create'))
    const first = await repository.createNote(api, 'capture', { text: 'https://youtu.be/dQw4w9WgXcQ' })
    const replay = await repository.createNote(api, 'capture', { text: 'https://youtu.be/dQw4w9WgXcQ' })
    expect(replay.response).toEqual(first.response)
    expect(await repository.agentStore.listRuns(bootstrap.outlineId, 10)).toHaveLength(1)
  })

  it('serializes rotating OAuth refresh tokens under the credential row lock', async () => {
    const repository = new PostgresServerRepository(pool, { instanceId: 'instance-test' })
    const bootstrap = await bootstrapSeeded(repository, 'owner@test.invalid')
    const jwtPayload = Buffer.from(JSON.stringify({ account_id: 'account-1' })).toString('base64url')
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({
      access_token: `x.${jwtPayload}.y`, refresh_token: 'rotated-refresh', expires_in: 3600,
    }), { status: 200 }))
    const service = new ServerCredentialService(new PostgresProviderCredentialStore(pool), {
      encryptionKeys: [{ version: 1, keyBase64: Buffer.alloc(32, 8).toString('base64') }], fetch,
      oauth: {
        deviceUrl: 'https://auth.example/device', deviceTokenUrl: 'https://auth.example/device/token',
        tokenUrl: 'https://auth.example/token', verificationUri: 'https://auth.example/verify',
        redirectUri: 'https://auth.example/callback', clientId: 'client', timeoutSeconds: 600,
      },
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
    const bootstrap = await bootstrapSeeded(repository, 'owner@test.invalid')
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
    const api = requireBoundOutline(await repository.authenticate(bootstrap.apiToken, 'notes:create'))
    await repository.createNote(api, 'concurrent-note', { text: 'Concurrent edit' })
    const structured = { version: 1 as const, nodes: [{ type: 'text' as const, text: 'Agent result' }], sources: [] }
    const first = await repository.commitAgentResult('run-result', 'worker', structured)
    const duplicate = await repository.commitAgentResult('run-result', 'worker', structured)
    expect(first).toEqual({ placement: 'placed', firstRevision: 2, lastRevision: 2, rootNoteIds: expect.any(Array) })
    expect(duplicate).toEqual(first)
    expect((await repository.eventsAfter(bootstrap.outlineId, 0, 10)).filter((event) => event.origin === 'agent')).toHaveLength(1)

    await repository.agentStore.admitRun({ input: runInput('run-cancel'), ownerId: bootstrap.ownerId, trigger: 'manual', triggerIdentity: 'manual:cancel', maxAttempts: 2 })
    await repository.agentStore.claimNext('worker', new Date(Date.now() + 1_000), 30_000)
    await repository.agentStore.requestCancellation(bootstrap.outlineId, 'run-cancel', new Date())
    await expect(repository.commitAgentResult('run-cancel', 'worker', structured)).rejects.toThrow(/cancellation/i)
    expect(await repository.agentStore.getRun(bootstrap.outlineId, 'run-cancel')).toMatchObject({ status: 'running' })
  })
})
