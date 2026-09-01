import { describe, expect, it, vi } from 'vitest'
import { DesktopSyncEngine, type SyncRepository, type SyncTransport } from './syncEngine'
import type { EventEnvelope, OutlineState } from '@forage/domain'
import { canonicalJson, reduceOutlineEvent, replayOutlineEvents, sha256Hex, sha256HexSync } from '@forage/domain'
import { EditorState } from '@tiptap/pm/state'
import {
  captureStepBatch,
  createOutlineSchema,
  deserializeStep,
  documentChangeSteps,
  repairSystemNodes,
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
  type TestCommit = {
    pulledEvents: EventEnvelope[]
    replacements: Array<{ originalId: string; event: EventEnvelope }>
    pulledRevision: number
    acknowledgements: Array<[string, number]>
  }
  const calls = {
    saveCheckpoint: vi.fn(async (_checkpoint: unknown) => undefined),
    append: vi.fn(async (_event: unknown) => 1),
    acknowledge: vi.fn(async (_outlineId: string, _acknowledgements: Array<[string, number]>) => undefined),
    supersede: vi.fn(async (_eventId: string, _replacementId: string) => undefined),
    recordPulled: vi.fn(async (_outlineId: string, _revision: number) => undefined),
    commitRebase: vi.fn(async (_outlineId: string, _commit: TestCommit) => undefined),
  }
  calls.commitRebase.mockImplementation(async (_outlineId: string, commit: TestCommit) => {
    for (const event of commit.pulledEvents) await calls.append(event)
    for (const replacement of commit.replacements) {
      await calls.append(replacement.event)
      await calls.supersede(replacement.originalId, replacement.event.id)
    }
    await calls.recordPulled('outline-1', commit.pulledRevision)
    await calls.acknowledge('outline-1', commit.acknowledgements)
  })
  return {
    calls,
    storageMode: async () => mode,
    loadReplayInput: async () => null,
    eventsAfter: async () => [],
    commitRebase: calls.commitRebase,
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
    const localTransaction = editorState.tr.insertText('L', 4)
    const remoteTransaction = editorState.tr.insertText('R', 8)
    const localBatch = captureStepBatch(base, localTransaction.steps)
    const remoteBatch = captureStepBatch(base, remoteTransaction.steps)
    const docEvent = (id: string, batch: typeof localBatch, after: typeof base, revision?: number): EventEnvelope => ({
      id, outlineId: 'outline-1', actorId: 'owner-1', deviceId: 'device-1',
      type: 'document.steps_applied', eventVersion: 1, documentVersion: 1, schemaEpoch: 1,
      baseRevision: revision ? revision - 1 : 0, revision, origin: 'desktop',
      occurredAt: '2026-08-30T12:00:00.000Z', changeGroupId: id,
      payload: {
        ...batch,
        beforeHash: sha256HexSync(canonicalJson(base.toJSON())),
        afterHash: sha256HexSync(canonicalJson(after.toJSON())),
      },
    })
    const pending = docEvent('local-doc', localBatch, localTransaction.doc)
    const remote = docEvent('remote-doc', remoteBatch, remoteTransaction.doc, 1)
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
    expect(engine.historyInvalidated).toBe(true)
    expect(repo.calls.supersede).toHaveBeenCalledWith('local-doc', expect.any(String))
  })

  it('does not store pulled events when a pending event cannot be rebased', async () => {
    const repo = repository('server')
    const pending: EventEnvelope = {
      id: 'local-shortcut', outlineId: 'outline-1', actorId: 'owner-1', deviceId: 'device-1',
      type: 'shortcut.created', eventVersion: 1, documentVersion: 1, schemaEpoch: 1,
      baseRevision: 0, origin: 'desktop', occurredAt: '2026-08-30T12:00:00.000Z',
      payload: { shortcut: { id: 'shortcut-1', kind: 'node', nodeId: 'inbox' } },
    }
    const schema = createOutlineSchema()
    const base = schema.nodeFromJSON(initialState.doc)
    const remoteTransaction = EditorState.create({ schema, doc: base }).tr.insertText('R', 8)
    const remote: EventEnvelope = {
      id: 'remote-doc', outlineId: 'outline-1', actorId: 'owner-1', deviceId: 'device-2',
      type: 'document.steps_applied', eventVersion: 1, documentVersion: 1, schemaEpoch: 1,
      baseRevision: 0, revision: 1, origin: 'server', occurredAt: '2026-08-30T12:00:00.000Z',
      changeGroupId: 'remote-doc',
      payload: {
        ...captureStepBatch(base, remoteTransaction.steps),
        beforeHash: sha256HexSync(canonicalJson(base.toJSON())),
        afterHash: sha256HexSync(canonicalJson(remoteTransaction.doc.toJSON())),
      },
    }
    const record = {
      localSequence: 1, id: pending.id, outlineId: pending.outlineId,
      baseRevision: 0, serverRevision: null, envelope: pending, status: 'pending' as const,
      supersededBy: null, createdAt: pending.occurredAt,
    }
    repo.loadReplayInput = async () => ({
      checkpoint: { id: 'checkpoint-local', outlineId: 'outline-1', documentVersion: 1,
        schemaEpoch: 1, localSequence: 0, serverRevision: 0, stateJson: JSON.stringify(initialState),
        integrityHash: 'a'.repeat(64), createdAt: '2026-08-30T12:00:00.000Z' },
      state: initialState, events: [pending],
    })
    repo.eventsAfter = async () => [record]
    repo.pending = async () => [record]
    const transport: SyncTransport = {
      status: async () => ({ ...status, eventVersions: {
        'document.steps_applied': [1], 'shortcut.created': [1],
      } }),
      checkpoint: async () => ({ checkpoint: { id: 'checkpoint', outlineId: 'outline-1', documentVersion: 1,
        schemaEpoch: 1, revision: 0, integrityHash: await sha256Hex(canonicalJson(initialState)), state: initialState } }),
      pull: async () => ({ events: [remote], currentRevision: 1, nextAfterRevision: null }),
      push: async () => ({ status: 'rebase_required', currentRevision: 1, pullAfterRevision: 0 }),
    }

    const engine = new DesktopSyncEngine(repo, transport)
    await engine.sync()

    expect(engine.state.kind).toBe('conflict')
    expect(repo.calls.append).not.toHaveBeenCalled()
    expect(repo.calls.recordPulled).not.toHaveBeenCalled()
    expect(repo.calls.supersede).not.toHaveBeenCalled()
  })

  it('builds a stale-push base without later pending records outside the first batch', async () => {
    const repo = repository('server')
    const pending = Array.from({ length: 101 }, (_, index) => noteEvent(
      `local-note-${index}`,
      `note-${index}`,
    ))
    const records = pending.map((event, index) => ({
      localSequence: index + 1, id: event.id, outlineId: event.outlineId,
      baseRevision: 0, serverRevision: null, envelope: event, status: 'pending' as const,
      supersededBy: null, createdAt: event.occurredAt,
    }))
    repo.loadReplayInput = async () => ({
      checkpoint: { id: 'checkpoint-local', outlineId: 'outline-1', documentVersion: 1,
        schemaEpoch: 1, localSequence: 0, serverRevision: 0, stateJson: JSON.stringify(initialState),
        integrityHash: 'a'.repeat(64), createdAt: '2026-08-30T12:00:00.000Z' },
      state: initialState, events: pending,
    })
    repo.eventsAfter = async () => records
    let pendingReads = 0
    repo.pending = async () => {
      pendingReads += 1
      return pendingReads === 1 ? records.slice(0, 100) : []
    }
    const schema = createOutlineSchema()
    const base = schema.nodeFromJSON(initialState.doc)
    const remoteTransaction = EditorState.create({ schema, doc: base }).tr.insertText('R', 8)
    const remote: EventEnvelope = {
      id: 'remote-doc', outlineId: 'outline-1', actorId: 'owner-1', deviceId: 'device-2',
      type: 'document.steps_applied', eventVersion: 1, documentVersion: 1, schemaEpoch: 1,
      baseRevision: 0, revision: 1, origin: 'server', occurredAt: '2026-08-30T12:00:00.000Z',
      changeGroupId: 'remote-doc',
      payload: {
        ...captureStepBatch(base, remoteTransaction.steps),
        beforeHash: sha256HexSync(canonicalJson(base.toJSON())),
        afterHash: sha256HexSync(canonicalJson(remoteTransaction.doc.toJSON())),
      },
    }
    let pushes = 0
    const transport: SyncTransport = {
      status: async () => ({ ...status, eventVersions: {
        'document.steps_applied': [1], 'note.created': [1],
      } }),
      checkpoint: async () => ({ checkpoint: { id: 'checkpoint', outlineId: 'outline-1', documentVersion: 1,
        schemaEpoch: 1, revision: 0, integrityHash: await sha256Hex(canonicalJson(initialState)), state: initialState } }),
      pull: async () => ({ events: [remote], currentRevision: 1, nextAfterRevision: null }),
      push: async (_baseRevision, events) => {
        pushes += 1
        if (pushes === 1) return { status: 'rebase_required', currentRevision: 1, pullAfterRevision: 0 }
        return {
          status: 'accepted',
          acknowledgements: events.map((event, index) => ({ eventId: event.id, revision: index + 2 })),
          currentRevision: events.length + 1,
        }
      },
    }

    const engine = new DesktopSyncEngine(repo, transport)
    await engine.sync()

    expect(engine.state.kind).toBe('up-to-date')
    expect(repo.calls.supersede).toHaveBeenCalledTimes(100)
    expect(engine.historyInvalidated).toBe(true)
  })

  it('rebases an atomic pending Trash move over an independent remote document edit', async () => {
    const repo = repository('server')
    const schema = createOutlineSchema()
    const state: OutlineState = {
      ...initialState,
      doc: {
        type: 'doc', content: [{ type: 'bulletList', content: [
          {
            type: 'listItem',
            attrs: { nodeId: 'keep', nodeType: 'user', collapsed: false, bulletKind: 'bullet', completed: false },
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'Keep' }] },
              { type: 'bulletList', content: [{
                type: 'listItem',
                attrs: { nodeId: 'remove', nodeType: 'user', collapsed: false, bulletKind: 'bullet', completed: false },
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Remove' }] }],
              }] },
            ],
          },
        ] }],
      },
    }
    const base = schema.nodeFromJSON(state.doc)
    let keepPos = -1
    let removePos = -1
    base.descendants((node, pos) => {
      if (node.type.name !== 'listItem') return
      if (node.attrs.nodeId === 'keep') keepPos = pos
      if (node.attrs.nodeId === 'remove') {
        removePos = pos
      }
    })
    const removeResolved = base.resolve(removePos)
    const childListStart = removeResolved.before(removeResolved.depth)
    const localTransaction = EditorState.create({ schema, doc: base }).tr
      .delete(childListStart, childListStart + removeResolved.parent.nodeSize)
    const remoteTransaction = EditorState.create({ schema, doc: base }).tr
      .insertText(' remote', keepPos + 2 + 'Keep'.length)
    remoteTransaction.insertText(
      ' remote',
      remoteTransaction.mapping.map(removePos + 2 + 'Remove'.length),
    )
    const entry = {
      id: 'trash-1', deletedAt: '2026-08-30T12:00:00.000Z', originalParentId: 'keep',
      originalIndex: 0, node: base.nodeAt(removePos)!.toJSON(),
    }
    const pending: EventEnvelope = {
      id: 'local-trash', outlineId: 'outline-1', actorId: 'owner-1', deviceId: 'device-1',
      type: 'trash.entry_added', eventVersion: 1, documentVersion: 1, schemaEpoch: 1,
      baseRevision: 0, origin: 'desktop', occurredAt: '2026-08-30T12:00:00.000Z',
      payload: {
        entry,
        document: {
          ...captureStepBatch(base, localTransaction.steps),
          beforeHash: sha256HexSync(canonicalJson(base.toJSON())),
          afterHash: sha256HexSync(canonicalJson(localTransaction.doc.toJSON())),
        },
      },
    }
    const remote: EventEnvelope = {
      id: 'remote-doc', outlineId: 'outline-1', actorId: 'owner-1', deviceId: 'device-2',
      type: 'document.steps_applied', eventVersion: 1, documentVersion: 1, schemaEpoch: 1,
      baseRevision: 0, revision: 1, origin: 'server', occurredAt: '2026-08-30T12:00:00.000Z',
      changeGroupId: 'remote-doc',
      payload: {
        ...captureStepBatch(base, remoteTransaction.steps),
        beforeHash: sha256HexSync(canonicalJson(base.toJSON())),
        afterHash: sha256HexSync(canonicalJson(remoteTransaction.doc.toJSON())),
      },
    }
    repo.loadReplayInput = async () => ({
      checkpoint: { id: 'checkpoint-local', outlineId: 'outline-1', documentVersion: 1,
        schemaEpoch: 1, localSequence: 0, serverRevision: 0, stateJson: JSON.stringify(state),
        integrityHash: 'a'.repeat(64), createdAt: '2026-08-30T12:00:00.000Z' },
      state, events: [],
    })
    repo.pending = async () => [{
      localSequence: 1, id: pending.id, outlineId: pending.outlineId,
      baseRevision: 0, serverRevision: null, envelope: pending, status: 'pending',
      supersededBy: null, createdAt: pending.occurredAt,
    }]
    let pushes = 0
    let replacements: EventEnvelope[] = []
    const transport: SyncTransport = {
      status: async () => ({ ...status, eventVersions: {
        'document.steps_applied': [1], 'trash.entry_added': [1],
      } }),
      checkpoint: async () => ({ checkpoint: { id: 'checkpoint', outlineId: 'outline-1', documentVersion: 1,
        schemaEpoch: 1, revision: 0, integrityHash: await sha256Hex(canonicalJson(state)), state } }),
      pull: async () => ({ events: [remote], currentRevision: 1, nextAfterRevision: null }),
      push: async (_base, events) => {
        pushes += 1
        if (pushes === 1) return { status: 'rebase_required', currentRevision: 1, pullAfterRevision: 0 }
        replacements = events
        return { status: 'accepted', acknowledgements: [{ eventId: events[0].id, revision: 2 }], currentRevision: 2 }
      },
    }

    const engine = new DesktopSyncEngine(repo, transport)
    await engine.sync()

    const replayed = replayOutlineEvents(state, [remote, ...replacements])
    expect(engine.state.kind).toBe('up-to-date')
    expect(replacements).toHaveLength(1)
    expect(replacements[0]).toMatchObject({
      type: 'trash.entry_added',
      payload: { entry: { id: 'trash-1' }, document: { beforeHash: expect.any(String), afterHash: expect.any(String) } },
    })
    expect(repo.calls.supersede).toHaveBeenCalledWith('local-trash', replacements[0].id)
    expect(schema.nodeFromJSON(replayed.doc).textContent).toBe('Keep remote')
    expect(replayed.trash).toHaveLength(1)
    expect(replayed.trash[0]).toMatchObject({ id: 'trash-1', originalParentId: 'keep', originalIndex: 0 })
    expect(schema.nodeFromJSON({
      type: 'doc', content: [{ type: 'bulletList', content: [replayed.trash[0].node] }],
    }).textContent).toBe('Remove remote')
  })

  it('rejects a pulled document event before storing it when its hash chain is invalid', async () => {
    const repo = repository('server')
    repo.loadReplayInput = async () => ({
      checkpoint: { id: 'checkpoint-local', outlineId: 'outline-1', documentVersion: 1,
        schemaEpoch: 1, localSequence: 0, serverRevision: 0, stateJson: JSON.stringify(initialState),
        integrityHash: 'a'.repeat(64), createdAt: '2026-08-30T12:00:00.000Z' },
      state: initialState, events: [],
    })
    const schema = createOutlineSchema()
    const document = schema.nodeFromJSON(initialState.doc)
    const transaction = EditorState.create({ schema, doc: document }).tr.insertText('!', 8)
    const corrupt: EventEnvelope = {
      id: 'corrupt', outlineId: 'outline-1', actorId: 'owner-1', deviceId: 'device-1',
      type: 'document.steps_applied', eventVersion: 1, documentVersion: 1, schemaEpoch: 1,
      baseRevision: 0, revision: 1, origin: 'server', occurredAt: '2026-08-30T12:00:00.000Z',
      payload: {
        ...captureStepBatch(document, transaction.steps),
        beforeHash: '0'.repeat(64),
        afterHash: sha256HexSync(canonicalJson(transaction.doc.toJSON())),
      },
    }
    const transport: SyncTransport = {
      status: async () => ({ ...status, eventVersions: { 'document.steps_applied': [1] } }),
      checkpoint: async () => ({ checkpoint: { id: 'checkpoint', outlineId: 'outline-1', documentVersion: 1,
        schemaEpoch: 1, revision: 0, integrityHash: await sha256Hex(canonicalJson(initialState)), state: initialState } }),
      pull: async () => ({ events: [corrupt], currentRevision: 1, nextAfterRevision: null }),
      push: async () => { throw new Error('no pending events') },
    }

    const engine = new DesktopSyncEngine(repo, transport)
    await engine.sync()

    expect(engine.state).toMatchObject({ kind: 'server-unavailable', message: expect.stringContaining('integrity mismatch') })
    expect(repo.calls.append).not.toHaveBeenCalled()
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
      before: typeof beforeMigration,
      after: typeof beforeMigration,
    ): EventEnvelope => ({
      id, outlineId: 'outline-1', actorId: 'owner-1', deviceId: 'device-1',
      type: 'document.steps_applied', eventVersion: 1, documentVersion: 1, schemaEpoch: 1,
      baseRevision: 0, origin, occurredAt: '2026-08-30T12:00:00.000Z', changeGroupId: id,
      payload: {
        ...batch,
        beforeHash: sha256HexSync(canonicalJson(before.toJSON())),
        afterHash: sha256HexSync(canonicalJson(after.toJSON())),
      },
    })
    const repairedOldMigration = schema.nodeFromJSON(repairSystemNodes(
      oldMigrationProjection.toJSON() as Record<string, unknown>,
      () => { throw new Error('Migration fixture unexpectedly needs an id.') },
    ).doc)
    const migration = documentEvent(
      'legacy-migration', migrationBatch, 'migration', beforeMigration, repairedOldMigration,
    )
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
      repairedDocument,
      editTransaction.doc,
    )
    const remoteTransaction = EditorState.create({ schema, doc: beforeMigration })
      .tr.insertText('R', 3 + 'Inbox'.length)
    const remote = {
      ...documentEvent(
        'remote-edit', captureStepBatch(beforeMigration, remoteTransaction.steps),
        'server', beforeMigration, remoteTransaction.doc,
      ),
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
