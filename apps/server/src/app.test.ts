// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import { buildServer, InMemoryServerRepository } from './index'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileSystemAssetStorage, verifyAssetBytes } from './assets'
import { captureStepBatch, createOutlineSchema } from '@forage/document'
import { canonicalJson, parseEventEnvelope, sha256Hex } from '@forage/domain'
import { Transform } from '@tiptap/pm/transform'

const servers: Array<ReturnType<typeof buildServer>> = []
const assetRoots: string[] = []

async function testServer() {
  const repository = new InMemoryServerRepository({ instanceId: 'instance-test' })
  const bootstrap = await repository.bootstrapOwner('owner@test.invalid')
  const assetRoot = await mkdtemp(join(tmpdir(), 'forage-app-assets-'))
  assetRoots.push(assetRoot)
  const app = buildServer({ repository, assetStorage: new FileSystemAssetStorage(assetRoot), logger: false })
  servers.push(app)
  return { app, repository, ...bootstrap }
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
  await Promise.all(assetRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('Forage server', () => {
  it('separates liveness, dependency readiness, and compatibility status', async () => {
    const { app } = await testServer()
    expect((await app.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(200)
    const status = await app.inject({ method: 'GET', url: '/api/v1/status' })
    expect(status.json()).toMatchObject({
      instanceId: 'instance-test', apiVersions: [1], documentSchemaVersion: 1,
    })
  })

  it('creates a plain-text note in the API Inbox with server identity and provenance', async () => {
    const { app, apiToken, deviceToken, inboxId, outlineId } = await testServer()
    const response = await app.inject({
      method: 'POST', url: '/api/v1/notes',
      headers: { authorization: `Bearer ${apiToken}`, 'idempotency-key': 'capture-1' },
      payload: { text: 'Captured externally', source: { application: 'Raycast' } },
    })

    expect(response.statusCode).toBe(201)
    expect(response.headers.location).toMatch(/^\/api\/v1\/notes\//)
    expect(response.json()).toMatchObject({ parentId: inboxId, origin: 'notes_api', revision: 1 })
    const checkpoint = await app.inject({
      method: 'GET', url: `/api/v1/outlines/${outlineId}/checkpoint`,
      headers: { authorization: `Bearer ${deviceToken}` },
    })
    expect(JSON.stringify(checkpoint.json().checkpoint.state.doc)).toContain(response.json().noteId)
  })

  it('bootstraps canonical Inbox and Daily Notes roles in the authoritative checkpoint', async () => {
    const { repository, outlineId, inboxId } = await testServer()
    const checkpoint = await repository.checkpoint(outlineId)
    const roleNodes: Array<[string, string]> = []
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) return value.forEach(visit)
      if (!value || typeof value !== 'object') return
      const node = value as Record<string, unknown>
      const attrs = node.attrs as Record<string, unknown> | undefined
      if (attrs?.systemRole) roleNodes.push([String(attrs.nodeId), String(attrs.systemRole)])
      Object.values(node).forEach(visit)
    }
    visit(checkpoint.state.doc)

    expect(roleNodes).toEqual(expect.arrayContaining([
      [inboxId, 'inbox'],
      [expect.any(String), 'daily-notes'],
    ]))
  })

  it('resolves the current canonical Inbox role for each default API capture', async () => {
    const { repository, outlineId, ownerId, apiToken, deviceToken, inboxId } = await testServer()
    const checkpoint = await repository.checkpoint(outlineId)
    const before = createOutlineSchema().nodeFromJSON(checkpoint.state.doc)
    let oldInboxPos = -1
    let replacementPos = -1
    let replacementId = ''
    before.descendants((node, pos) => {
      if (node.type.name !== 'listItem') return
      if (node.attrs.nodeId === inboxId) oldInboxPos = pos
      if (!replacementId && node.attrs.systemRole == null && node.attrs.nodeId !== inboxId) {
        replacementPos = pos
        replacementId = String(node.attrs.nodeId)
      }
    })
    const transform = new Transform(before)
      .setNodeMarkup(oldInboxPos, undefined, { ...before.nodeAt(oldInboxPos)!.attrs, systemRole: null })
      .setNodeMarkup(replacementPos, undefined, { ...before.nodeAt(replacementPos)!.attrs, systemRole: 'inbox' })
    const batch = captureStepBatch(before, transform.steps)
    const event = parseEventEnvelope({
      id: 'event-transfer-inbox', outlineId, actorId: ownerId, deviceId: 'device-test',
      type: 'document.steps_applied', eventVersion: 1, documentVersion: 1, schemaEpoch: 1,
      baseRevision: 0, origin: 'desktop', occurredAt: '2026-08-30T12:00:00.000Z',
      payload: {
        ...batch,
        beforeHash: await sha256Hex(canonicalJson(before.toJSON())),
        afterHash: await sha256Hex(canonicalJson(transform.doc.toJSON())),
      },
    })
    const device = await repository.authenticate(deviceToken, 'sync')
    await repository.acceptEvents(device, 0, [event])
    const api = await repository.authenticate(apiToken, 'notes:create')

    const created = await repository.createNote(api, 'role-routed', { text: 'Role routed' })

    expect(created.response.parentId).toBe(replacementId)
    expect(created.response.parentId).not.toBe(inboxId)
  })

  it('replays an identical idempotent retry and rejects changed input for the same key', async () => {
    const { app, apiToken } = await testServer()
    const request = {
      method: 'POST' as const, url: '/api/v1/notes',
      headers: { authorization: `Bearer ${apiToken}`, 'idempotency-key': 'capture-1' },
      payload: { text: 'Same input' },
    }
    const first = await app.inject(request)
    const retry = await app.inject(request)
    const conflict = await app.inject({ ...request, payload: { text: 'Changed input' } })

    expect(retry.statusCode).toBe(200)
    expect(retry.json()).toEqual(first.json())
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json().error.code).toBe('idempotency_conflict')
  })

  it('does not disclose outline resources to invalid or insufficiently scoped tokens', async () => {
    const { app, deviceToken } = await testServer()
    const request = (token: string) => app.inject({
      method: 'POST', url: '/api/v1/notes',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': 'capture-1' },
      payload: { text: 'Denied', parentId: 'does-not-exist' },
    })
    expect((await request('invalid')).statusCode).toBe(401)
    expect((await request(deviceToken)).statusCode).toBe(403)
  })

  it('returns rebase_required for a stale push without advancing the outline revision', async () => {
    const { app, apiToken, deviceToken, outlineId } = await testServer()
    await app.inject({
      method: 'POST', url: '/api/v1/notes',
      headers: { authorization: `Bearer ${apiToken}`, 'idempotency-key': 'capture-1' },
      payload: { text: 'Remote event' },
    })
    const stale = await app.inject({
      method: 'POST', url: `/api/v1/outlines/${outlineId}/events`,
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { baseRevision: 0, events: [] },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toEqual({ status: 'rebase_required', currentRevision: 1, pullAfterRevision: 0 })
  })

  it('uploads, deduplicates, and downloads an authenticated verified asset', async () => {
    const { app, deviceToken } = await testServer()
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])
    const metadata = await verifyAssetBytes(bytes, 'image/png')
    const headers = { authorization: `Bearer ${deviceToken}` }
    const initiated = await app.inject({ method: 'POST', url: '/api/v1/assets/initiate', headers, payload: metadata })
    expect(initiated.json().status).toBe('upload_required')
    const completed = await app.inject({
      method: 'POST', url: `/api/v1/assets/${metadata.assetId}/complete`, headers,
      payload: { mediaType: metadata.mediaType, byteSize: metadata.byteSize, bytesBase64: bytes.toString('base64') },
    })
    expect(completed.statusCode).toBe(200)
    expect(completed.json().status).toBe('complete')
    const deduplicated = await app.inject({ method: 'POST', url: '/api/v1/assets/initiate', headers, payload: metadata })
    expect(deduplicated.json().status).toBe('complete')
    const downloaded = await app.inject({ method: 'GET', url: `/api/v1/assets/${metadata.assetId}`, headers })
    expect(Buffer.from(downloaded.json().bytesBase64, 'base64')).toEqual(bytes)
  })

  it('keeps interrupted uploads incomplete and rejects forged completion bytes', async () => {
    const { app, deviceToken } = await testServer()
    const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])
    const metadata = await verifyAssetBytes(bytes, 'image/png')
    const headers = { authorization: `Bearer ${deviceToken}` }
    await app.inject({ method: 'POST', url: '/api/v1/assets/initiate', headers, payload: metadata })
    const retry = await app.inject({ method: 'POST', url: '/api/v1/assets/initiate', headers, payload: metadata })
    expect(retry.json().status).toBe('upload_required')
    const forged = await app.inject({
      method: 'POST', url: `/api/v1/assets/${metadata.assetId}/complete`, headers,
      payload: { mediaType: metadata.mediaType, byteSize: metadata.byteSize, bytesBase64: Buffer.from('forged').toString('base64') },
    })
    expect(forged.statusCode).toBe(400)
    expect((await app.inject({ method: 'GET', url: `/api/v1/assets/${metadata.assetId}`, headers })).statusCode).toBe(403)
  })

  it('validates note parents and rejects rich or oversized external input', async () => {
    const { app, apiToken } = await testServer()
    const headers = { authorization: `Bearer ${apiToken}`, 'idempotency-key': 'invalid' }
    expect((await app.inject({ method: 'POST', url: '/api/v1/notes', headers, payload: { text: 'x', parentId: 'missing' } })).statusCode).toBe(409)
    expect((await app.inject({ method: 'POST', url: '/api/v1/notes', headers: { ...headers, 'idempotency-key': 'html' }, payload: { text: 'x', html: '<b>x</b>' } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/api/v1/notes', headers: { ...headers, 'idempotency-key': 'nested' }, payload: { text: 'x', children: [{ text: 'y' }] } })).statusCode).toBe(400)
    expect((await app.inject({ method: 'POST', url: '/api/v1/notes', headers: { ...headers, 'idempotency-key': 'large' }, payload: { text: 'x'.repeat(100_001) } })).statusCode).toBe(400)
  })

  it('paginates pulls and refuses an event referencing an unknown asset atomically', async () => {
    const { app, apiToken, deviceToken, outlineId, ownerId } = await testServer()
    for (let index = 0; index < 2; index += 1) {
      await app.inject({ method: 'POST', url: '/api/v1/notes',
        headers: { authorization: `Bearer ${apiToken}`, 'idempotency-key': `page-${index}` },
        payload: { text: `note ${index}` },
      })
    }
    const page = await app.inject({ method: 'GET', url: `/api/v1/outlines/${outlineId}/events?afterRevision=0&limit=1`, headers: { authorization: `Bearer ${deviceToken}` } })
    expect(page.json()).toMatchObject({ currentRevision: 2, nextAfterRevision: 1 })
    const event = {
      id: 'event-asset', outlineId, actorId: ownerId, deviceId: 'device-test',
      type: 'asset.reference_added', eventVersion: 1, documentVersion: 1, schemaEpoch: 1,
      baseRevision: 2, origin: 'desktop', occurredAt: '2026-08-30T12:00:00.000Z',
      payload: { assetId: '0'.repeat(64), alt: 'missing' },
    }
    const rejected = await app.inject({ method: 'POST', url: `/api/v1/outlines/${outlineId}/events`, headers: { authorization: `Bearer ${deviceToken}` }, payload: { baseRevision: 2, events: [event] } })
    expect(rejected.statusCode).toBe(409)
    const status = await app.inject({ method: 'GET', url: `/api/v1/outlines/${outlineId}/events?afterRevision=2&limit=1`, headers: { authorization: `Bearer ${deviceToken}` } })
    expect(status.json().currentRevision).toBe(2)
  })
})
