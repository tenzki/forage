import { describe, expect, it, vi } from 'vitest'
import { DesktopSyncEngine, type SyncRepository, type SyncTransport } from './syncEngine'
import type { EventEnvelope, OutlineState } from '@forage/domain'
import { canonicalJson, reduceOutlineEvent, replayOutlineEvents, sha256Hex } from '@forage/domain'
import { EditorState } from '@tiptap/pm/state'
import {
  captureStepBatch,
  createOutlineSchema,
  deserializeStep,
  documentChangeSteps,
} from '@forage/document'

const initialState: OutlineState = {
  doc: {
    type: 'doc', content: [{ type: 'bulletList', content: [{
      type: 'listItem',
      attrs: { nodeId: 'inbox', nodeType: 'user', collapsed: false, bulletKind: 'bullet', completed: false },
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Inbox' }] }],
    }] }],
  },
  trash: [], shortcuts: [], schemaEpoch: 1,
}

function noteEvent(id: string, noteId: string, revision?: number): EventEnvelope {
  return {
    id, outlineId: 'outline-1', actorId: 'owner-1', deviceId: 'device-1',
    type: 'note.created', eventVersion: 1, documentVersion: 1, schemaEpoch: 1,
    baseRevision: revision ? revision - 1 : 0, revision, origin: 'desktop',
    occurredAt: '2026-08-30T12:00:00.000Z',
    payload: { noteId, parentId: 'inbox', text: noteId },
  }
}

function repository(mode: 'local' | 'server'): SyncRepository & { calls: Record<string, ReturnType<typeof vi.fn>> } {
  const calls = {
    saveCheckpoint: vi.fn(async () => undefined), append: vi.fn(async () => 1),
    acknowledge: vi.fn(async () => undefined), supersede: vi.fn(async () => undefined),
    recordPulled: vi.fn(async () => undefined),
  }
  return {
    calls,
    storageMode: async () => mode,
    loadReplayInput: async () => null,
    saveCheckpoint: calls.saveCheckpoint,
    append: calls.append,
    pending: async () => [],
    acknowledge: calls.acknowledge,
    supersede: calls.supersede,
    syncState: async () => ({ lastAckedRevision: 0, lastPulledRevision: 0 }),
    recordPulled: calls.recordPulled,
  }
}

const status = {
  instanceId: 'instance-1', apiVersions: [1], eventVersions: { 'note.created': [1] },
  documentSchemaVersion: 1, minimumClientVersion: '0.1.0',
}

describe('desktop synchronization state machine', () => {
  it('makes no network request in explicit local-only mode', async () => {
    const repo = repository('local')
    const transport = { status: vi.fn() } as unknown as SyncTransport
    const engine = new DesktopSyncEngine(repo, transport)
    await engine.sync()
    expect(engine.state.kind).toBe('local-only')
    expect(transport.status).not.toHaveBeenCalled()
  })

  it('bootstraps a new device from a compatible checkpoint and reaches up-to-date', async () => {
    const repo = repository('server')
    const transport: SyncTransport = {
      status: async () => status,
      checkpoint: async () => ({
        checkpoint: { id: 'checkpoint-1', outlineId: 'outline-1', documentVersion: 1,
          schemaEpoch: 1, revision: 0, integrityHash: await sha256Hex(canonicalJson(initialState)), state: initialState },
      }),
      pull: async () => ({ events: [], currentRevision: 0, nextAfterRevision: null }),
      push: async () => { throw new Error('no pending events') },
    }
    const states: string[] = []
    const engine = new DesktopSyncEngine(repo, transport, (state) => states.push(state.kind))
    await engine.sync()

    expect(states).toEqual(['connecting', 'syncing', 'up-to-date'])
    expect(repo.calls.saveCheckpoint).toHaveBeenCalledOnce()
  })

  it('automatically supersedes and retries an independent pending note after a stale push', async () => {
    const repo = repository('server')
    const pending = noteEvent('local-event', 'local-note')
    repo.loadReplayInput = async () => ({
      checkpoint: { id: 'checkpoint-local', outlineId: 'outline-1', documentVersion: 1,
        schemaEpoch: 1, localSequence: 0, serverRevision: 0, stateJson: JSON.stringify(initialState),
        integrityHash: 'a'.repeat(64), createdAt: '2026-08-30T12:00:00.000Z' },
      state: initialState, events: [],
    })
    repo.pending = async () => [{ localSequence: 1, id: pending.id, outlineId: pending.outlineId,
      baseRevision: 0, serverRevision: null, envelope: pending, status: 'pending',
      supersededBy: null, createdAt: pending.occurredAt }]
    let pushes = 0
    const remote = noteEvent('remote-event', 'remote-note', 1)
    const transport: SyncTransport = {
      status: async () => status,
      checkpoint: async () => ({
        checkpoint: { id: 'checkpoint-1', outlineId: 'outline-1', documentVersion: 1,
          schemaEpoch: 1, revision: 0, integrityHash: await sha256Hex(canonicalJson(initialState)), state: initialState },
      }),
      pull: async (after) => after === 0
        ? { events: [remote], currentRevision: 1, nextAfterRevision: null }
        : { events: [], currentRevision: 1, nextAfterRevision: null },
      push: async (_base, events) => {
        pushes += 1
        if (pushes === 1) return { status: 'rebase_required', currentRevision: 1, pullAfterRevision: 0 }
        return { status: 'accepted', acknowledgements: [{ eventId: events[0].id, revision: 2 }], currentRevision: 2 }
      },
    }

    const engine = new DesktopSyncEngine(repo, transport)
    await engine.sync()

    expect(repo.calls.supersede).toHaveBeenCalledWith('local-event', expect.not.stringMatching('local-event'))
    expect(repo.calls.append).toHaveBeenCalledWith(expect.objectContaining({
      type: 'note.created', baseRevision: 1,
    }))
    expect(engine.state.kind).toBe('up-to-date')
  })

  it('rebases an independent pending document edit over a remote document edit', async () => {
    const repo = repository('server')
    const schema = createOutlineSchema()
    const base = schema.nodeFromJSON(initialState.doc)
    const editorState = EditorState.create({ schema, doc: base })
    const localBatch = captureStepBatch(base, editorState.tr.insertText('L', 4).steps)
    const remoteBatch = captureStepBatch(base, editorState.tr.insertText('R', 8).steps)
    const docEvent = (id: string, batch: typeof localBatch, revision?: number): EventEnvelope => ({
      id, outlineId: 'outline-1', actorId: 'owner-1', deviceId: 'device-1',
      type: 'document.steps_applied', eventVersion: 1, documentVersion: 1, schemaEpoch: 1,
      baseRevision: revision ? revision - 1 : 0, revision, origin: 'desktop',
      occurredAt: '2026-08-30T12:00:00.000Z', changeGroupId: id,
      payload: { ...batch, beforeHash: 'a'.repeat(64), afterHash: 'b'.repeat(64) },
    })
    const pending = docEvent('local-doc', localBatch)
    const remote = docEvent('remote-doc', remoteBatch, 1)
    repo.loadReplayInput = async () => ({
      checkpoint: { id: 'checkpoint-local', outlineId: 'outline-1', documentVersion: 1,
        schemaEpoch: 1, localSequence: 0, serverRevision: 0, stateJson: JSON.stringify(initialState),
        integrityHash: 'a'.repeat(64), createdAt: '2026-08-30T12:00:00.000Z' },
      state: initialState, events: [],
    })
    repo.pending = async () => [{ localSequence: 1, id: pending.id, outlineId: pending.outlineId,
      baseRevision: 0, serverRevision: null, envelope: pending, status: 'pending',
      supersededBy: null, createdAt: pending.occurredAt }]
    let pushes = 0
    const transport: SyncTransport = {
      status: async () => ({ ...status, eventVersions: { 'document.steps_applied': [1] } }),
      checkpoint: async () => ({ checkpoint: { id: 'checkpoint', outlineId: 'outline-1', documentVersion: 1,
        schemaEpoch: 1, revision: 0, integrityHash: await sha256Hex(canonicalJson(initialState)), state: initialState } }),
      pull: async () => ({ events: [remote], currentRevision: 1, nextAfterRevision: null }),
      push: async (_base, events) => {
        pushes += 1
        if (pushes === 1) return { status: 'rebase_required', currentRevision: 1, pullAfterRevision: 0 }
        return { status: 'accepted', acknowledgements: [{ eventId: events[0].id, revision: 2 }], currentRevision: 2 }
      },
    }
    const engine = new DesktopSyncEngine(repo, transport)
    await engine.sync()
    expect(engine.state.kind).toBe('up-to-date')
    expect(repo.calls.supersede).toHaveBeenCalledWith('local-doc', expect.any(String))
  })

  it('rebases follow-up edits against the repaired projection of a pending legacy migration', async () => {
    const repo = repository('server')
    const schema = createOutlineSchema()
    const item = (id: string, text: string, role: string | null = null) => ({
      type: 'listItem',
      attrs: {
        nodeId: id, nodeType: 'user', collapsed: false, bulletKind: 'bullet', completed: false,
        systemRole: role, dailyDate: null,
      },
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    })
    const legacyState: OutlineState = {
      doc: {
        type: 'doc', content: [
          { type: 'bulletList', content: [item('inbox', 'Inbox', 'inbox')] },
          { type: 'bulletList', content: [item('person', 'Nikola B')] },
        ],
      },
      trash: [], shortcuts: [], schemaEpoch: 1,
    }
    const beforeMigration = schema.nodeFromJSON(legacyState.doc)
    const oldMigrationProjection = schema.nodeFromJSON({
      type: 'doc', content: [
        { type: 'bulletList', content: [
          item('inbox', 'Inbox', 'inbox'),
          item('daily', 'Daily Notes', 'daily-notes'),
        ] },
        { type: 'bulletList', content: [item('person', 'Nikola B')] },
      ],
    })
    const migrationBatch = captureStepBatch(
      beforeMigration,
      documentChangeSteps(beforeMigration, oldMigrationProjection)
        .map((step) => deserializeStep(schema, step)),
    )
    const documentEvent = (
      id: string,
      batch: typeof migrationBatch,
      origin: EventEnvelope['origin'],
    ): EventEnvelope => ({
      id, outlineId: 'outline-1', actorId: 'owner-1', deviceId: 'device-1',
      type: 'document.steps_applied', eventVersion: 1, documentVersion: 1, schemaEpoch: 1,
      baseRevision: 0, origin, occurredAt: '2026-08-30T12:00:00.000Z', changeGroupId: id,
      payload: { ...batch, beforeHash: 'a'.repeat(64), afterHash: 'b'.repeat(64) },
    })
    const migration = documentEvent('legacy-migration', migrationBatch, 'migration')
    const repairedAfterMigration = reduceOutlineEvent(legacyState, migration)
    const repairedDocument = schema.nodeFromJSON(repairedAfterMigration.doc)
    let personPos = -1
    repairedDocument.descendants((node, pos) => {
      if (node.type.name === 'listItem' && node.attrs.nodeId === 'person') personPos = pos
    })
    const editTransaction = EditorState.create({ schema, doc: repairedDocument })
      .tr.insertText('!', personPos + 2 + 'Nikola B'.length)
    const edit = documentEvent(
      'follow-up-edit',
      captureStepBatch(repairedDocument, editTransaction.steps),
      'desktop',
    )
    const remoteTransaction = EditorState.create({ schema, doc: beforeMigration })
      .tr.insertText('R', 3 + 'Inbox'.length)
    const remote = {
      ...documentEvent('remote-edit', captureStepBatch(beforeMigration, remoteTransaction.steps), 'server'),
      revision: 1,
    }
    repo.loadReplayInput = async () => ({
      checkpoint: { id: 'checkpoint-local', outlineId: 'outline-1', documentVersion: 1,
        schemaEpoch: 1, localSequence: 0, serverRevision: 0, stateJson: JSON.stringify(legacyState),
        integrityHash: 'a'.repeat(64), createdAt: '2026-08-30T12:00:00.000Z' },
      state: legacyState, events: [],
    })
    repo.pending = async () => [migration, edit].map((event, index) => ({
      localSequence: index + 1, id: event.id, outlineId: event.outlineId,
      baseRevision: 0, serverRevision: null, envelope: event, status: 'pending' as const,
      supersededBy: null, createdAt: event.occurredAt,
    }))
    let pushes = 0
    let replacements: EventEnvelope[] = []
    const transport: SyncTransport = {
      status: async () => ({ ...status, eventVersions: { 'document.steps_applied': [1] } }),
      checkpoint: async () => ({ checkpoint: { id: 'checkpoint', outlineId: 'outline-1', documentVersion: 1,
        schemaEpoch: 1, revision: 0, integrityHash: await sha256Hex(canonicalJson(legacyState)), state: legacyState } }),
      pull: async () => ({ events: [remote], currentRevision: 1, nextAfterRevision: null }),
      push: async (_base, events) => {
        pushes += 1
        if (pushes === 1) return { status: 'rebase_required', currentRevision: 1, pullAfterRevision: 0 }
        replacements = events
        return {
          status: 'accepted',
          acknowledgements: events.map((event, index) => ({ eventId: event.id, revision: index + 2 })),
          currentRevision: events.length + 1,
        }
      },
    }

    const engine = new DesktopSyncEngine(repo, transport)
    await engine.sync()
    const replayed = replayOutlineEvents(legacyState, [remote, ...replacements])
    const afterMigrationReplacement = replayOutlineEvents(legacyState, [remote, replacements[0]])
    const repairedMigrationHash = await sha256Hex(canonicalJson(
      schema.nodeFromJSON(afterMigrationReplacement.doc).toJSON(),
    ))

    const replayedDocument = schema.nodeFromJSON(replayed.doc)
    expect(engine.state.kind).toBe('up-to-date')
    expect(replacements[0].payload).toMatchObject({ afterHash: repairedMigrationHash })
    expect(replacements[1].payload).toMatchObject({ beforeHash: repairedMigrationHash })
    expect(replayedDocument.childCount).toBe(1)
    expect(replayedDocument.textContent).toContain('InboxR')
    expect(replayedDocument.textContent).toContain('Nikola B!')
  })
})
