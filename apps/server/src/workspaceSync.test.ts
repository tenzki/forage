// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { buildServer, InMemoryServerRepository, requireBoundOutline } from './index'
import {
  OutlineSession,
  type OutlineSessionRepository,
} from '../../desktop/src/application/OutlineSession'
import { DocumentCoordinator } from '../../desktop/src/editor/DocumentCoordinator'
import { captureDocumentEvent } from '../../desktop/src/editor/eventCapture'
import { normalizeOutlinerDoc, EMPTY_DOC } from '../../desktop/src/editor/emptyDoc'
import { findBullet, collectBullets } from '../../desktop/src/editor/outlineModel'
import {
  createInitialOutlineState,
  parseEventEnvelope,
  type EventEnvelope,
  type OutlineState,
} from '@forage/domain'
import type { StoredCheckpoint, StoredEventRecord } from '../../desktop/src/persistence/eventStore'
import type { SyncTransport } from '../../desktop/src/sync/syncEngine'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileSystemAssetStorage } from './assets'
import type { JsonValue } from '../../desktop/src/types/tree'
// In-process HTTP injection runs the production routes/auth/repository, without
// a browser, a live daemon, or touching the development PostgreSQL database.
it('reconnects cross-pane offline edits through the server API and projects a late result once after source closure', async () => {
  const serverRepo = new InMemoryServerRepository({ instanceId: 'workspace-sync' })
  const bootstrap = await serverRepo.bootstrapOwner('workspace@test.invalid')
  const outlineId = 'workspace-outline'
  await serverRepo.claimOutline(await serverRepo.authenticate(bootstrap.deviceToken, 'sync'), {
    outlineId,
    name: 'Workspace',
  })
  const principal = requireBoundOutline(
    await serverRepo.authenticate(bootstrap.deviceToken, 'sync'),
  )
  const initial = createInitialOutlineState(
    normalizeOutlinerDoc(EMPTY_DOC) as Record<string, unknown>,
  )
  await serverRepo.seedOutline(principal, initial)
  const assets = await mkdtemp(join(tmpdir(), 'workspace-sync-assets-'))
  const app = buildServer({
    repository: serverRepo,
    logger: false,
    assetStorage: new FileSystemAssetStorage(assets),
  })
  let offline = false
  const request = async (url: string, payload?: unknown, token = bootstrap.deviceToken) => {
    if (offline) throw new Error('Network disconnected')
    const response = await app.inject({
      method: payload ? 'POST' : 'GET',
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload
        ? {
            payload: JSON.stringify(payload),
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          }
        : {}),
    })
    expect([200, 201, 409]).toContain(response.statusCode)
    return response.json()
  }
  const transport: SyncTransport = {
    status: () => request('/api/v1/status'),
    checkpoint: () => request(`/api/v1/outlines/${outlineId}/checkpoint`),
    pull: (afterRevision, limit = 100) =>
      request(`/api/v1/outlines/${outlineId}/events?afterRevision=${afterRevision}&limit=${limit}`),
    push: (baseRevision, events) =>
      request(`/api/v1/outlines/${outlineId}/events`, { baseRevision, events }),
  }
  const records: StoredEventRecord[] = []
  let checkpoint: StoredCheckpoint | null = null
  let acked = 0,
    pulled = 0
  const repository: OutlineSessionRepository = {
    identity: async () => ({ outlineId, actorId: bootstrap.ownerId, deviceId: 'workspace-device' }),
    serverConnection: async () => ({
      outlineId,
      origin: 'http://workspace.invalid',
      instanceId: 'workspace-sync',
    }),
    storageMode: async () => 'server',
    interruptUnfinishedAgentRuns: async () => 0,
    recentAgentRuns: async () => [],
    clearAgentRuns: async () => 0,
    agentRun: async () => null,
    placeAgentRunResult: async () => undefined,
    eventsAfter: async (_id, after) => records.filter((r) => r.localSequence > after),
    eventsBefore: async (_id, before, limit) =>
      records.filter((r) => r.localSequence <= before).slice(-limit),
    saveCheckpoint: async (value) => {
      checkpoint = value
    },
    loadReplayInput: async () =>
      checkpoint
        ? {
            checkpoint,
            state: JSON.parse(checkpoint.stateJson) as OutlineState,
            latestLocalSequence: records.length,
            events: records
              .filter((r) => !r.supersededBy && r.localSequence > checkpoint!.localSequence)
              .map((r) =>
                parseEventEnvelope({
                  ...(r.envelope as EventEnvelope),
                  ...(r.serverRevision !== null ? { revision: r.serverRevision } : {}),
                }),
              ),
          }
        : null,
    append: async (value) => {
      const e = parseEventEnvelope(value)
      const found = records.find((r) => r.id === e.id)
      if (found) return found.localSequence
      records.push({
        id: e.id,
        outlineId,
        localSequence: records.length + 1,
        baseRevision: e.baseRevision,
        serverRevision: e.revision ?? null,
        envelope: e,
        status: e.revision === undefined ? 'pending' : 'accepted',
        supersededBy: null,
        createdAt: e.occurredAt,
      })
      return records.length
    },
    pending: async (_id, limit = 100) =>
      records.filter((r) => r.status === 'pending' && !r.supersededBy).slice(0, limit),
    acknowledge: async (_id, pairs) => {
      for (const [id, revision] of pairs) {
        const r = records.find((r) => r.id === id)!
        r.status = 'accepted'
        r.serverRevision = revision
        acked = Math.max(acked, revision)
      }
    },
    supersede: async (id, replacement) => {
      records.find((r) => r.id === id)!.supersededBy = replacement
    },
    recordPulled: async (_id, revision) => {
      pulled = Math.max(pulled, revision)
    },
    syncState: async () => ({ lastAckedRevision: acked, lastPulledRevision: pulled }),
    commitRebase: async (id, commit) => {
      for (const e of commit.pulledEvents) await repository.append(e)
      for (const { originalId, event } of commit.replacements) {
        await repository.append(event)
        await repository.supersede(originalId, event.id)
      }
      await repository.recordPulled(id, commit.pulledRevision)
      await repository.acknowledge(id, commit.acknowledgements)
    },
  }
  const session = new OutlineSession(repository, transport)
  const pending: Promise<void>[] = []
  const opened = await session.open()
  const coordinator = new DocumentCoordinator(opened.state.doc as JsonValue, {
    onTransaction: (root, appended) => {
      const captured = captureDocumentEvent(root, appended, {
        ...session.context()!,
        nextChangeGroupId: () => crypto.randomUUID(),
      })
      if (captured) pending.push(session.persistCaptured(captured))
    },
  })
  try {
    const views = ['one', 'two', 'three'].map((id) => coordinator.createView(id))
    const target = collectBullets(coordinator.editor.state.doc).find(
      (b) => b.systemRole === null,
    )!.id
    offline = true
    for (const [i, view] of views.entries())
      view.view.dispatch(
        view.state.tr.insertText(`pane${i}`, findBullet(view.state.doc, target)!.pos + 2),
      )
    await Promise.all(pending)
    expect(records).toHaveLength(3)
    expect(await session.synchronize()).toBeNull()
    expect(session.getSnapshot().syncState.kind).toBe('server-unavailable')
    expect((await repository.pending(outlineId)).length).toBe(3)
    expect(views.every((v) => v.state.doc.eq(coordinator.editor.state.doc))).toBe(true)
    offline = false
    await request('/api/v1/notes', { text: 'Concurrent server capture' }, bootstrap.apiToken)
    const synchronize = () =>
      session.synchronize((projection) => {
        coordinator.editor.view.dispatch(
          coordinator.editor.state.tr
            .replaceWith(
              0,
              coordinator.editor.state.doc.content.size,
              coordinator.editor.schema.nodeFromJSON(projection.state.doc).content,
            )
            .setMeta('forageRemote', true),
        )
      })
    const reconnected = await synchronize()
    expect(session.getSnapshot().syncState).toEqual({ kind: 'up-to-date', revision: 4 })
    expect(reconnected?.historyInvalidated).toBe(true)
    expect(records.filter((r) => r.supersededBy)).toHaveLength(3)
    expect(await repository.pending(outlineId)).toEqual([])
    expect(records.filter((r) => !r.supersededBy)).toHaveLength(4)
    const expected = (await serverRepo.checkpoint(outlineId)).state.doc
    expect(coordinator.editor.getJSON()).toEqual(expected)
    expect(views.every((v) => v.state.doc.eq(coordinator.editor.state.doc))).toBe(true)
    const beforeResult = records.length
    views[1].destroy()
    const event: EventEnvelope = {
      id: 'late-result',
      outlineId,
      actorId: bootstrap.ownerId,
      deviceId: 'agent-server',
      type: 'agent.result_committed',
      eventVersion: 1,
      documentVersion: 1,
      schemaEpoch: 1,
      baseRevision: 4,
      origin: 'agent',
      occurredAt: new Date().toISOString(),
      changeGroupId: 'run_late',
      agentProvenance: { runId: 'late', skillId: 'ask', sourceNodeId: target, sourceUrls: [] },
      payload: {
        runId: 'late',
        targetNodeId: target,
        nodes: [{ type: 'text', nodeId: 'late-child', text: 'Stable result after pane close' }],
        sources: [],
      },
    }
    await transport.push(4, [event])
    await synchronize()
    expect(records).toHaveLength(beforeResult + 1)
    expect(findBullet(coordinator.editor.state.doc, target)!.node.textContent).toContain(
      'Stable result after pane close',
    )
    expect([views[0], views[2]].every((v) => v.state.doc.eq(coordinator.editor.state.doc))).toBe(
      true,
    )
    await synchronize()
    expect(records).toHaveLength(beforeResult + 1)
    expect(coordinator.editor.getJSON()).toEqual((await serverRepo.checkpoint(outlineId)).state.doc)
  } finally {
    coordinator.destroy()
    await app.close()
    await rm(assets, { recursive: true, force: true })
  }
}, 20000)
