import { describe, expect, it } from 'vitest'
import { parseEventEnvelope, type EventEnvelope, type OutlineState } from '@forage/domain'
import { createOutlineSchema } from '@forage/document'
import { EditorState } from '@tiptap/pm/state'
import { EMPTY_DOC } from '../editor/emptyDoc'
import { captureDocumentEvent } from '../editor/eventCapture'
import { OutlineSession, type OutlineSessionRepository } from './OutlineSession'

function repository(overrides: Partial<OutlineSessionRepository> = {}) {
  const checkpoints: Parameters<OutlineSessionRepository['saveCheckpoint']>[0][] = []
  const events: EventEnvelope[] = []
  let sequence = 0
  const value: OutlineSessionRepository = {
    identity: async () => ({ outlineId: 'outline-1', actorId: 'owner-1', deviceId: 'device-1' }),
    serverConnection: async () => null,
    interruptUnfinishedAgentRuns: async () => 0,
    recentAgentRuns: async () => [],
    clearAgentRuns: async () => 0,
    agentRun: async () => null,
    placeAgentRunResult: async () => undefined,
    storageMode: async () => 'local',
    loadReplayInput: async () => null,
    eventsAfter: async () => [],
    eventsBefore: async () => [],
    saveCheckpoint: async (checkpoint) => { checkpoints.push(checkpoint) },
    append: async (event) => {
      events.push(event as EventEnvelope)
      sequence += 1
      return sequence
    },
    commitRebase: async () => undefined,
    pending: async () => [],
    acknowledge: async () => undefined,
    supersede: async () => undefined,
    syncState: async (outlineId) => ({
      outlineId,
      lastAckedRevision: 0,
      lastPulledRevision: 0,
      serverInstanceId: null,
    }),
    recordPulled: async () => undefined,
    ...overrides,
  }
  return { value, checkpoints, events }
}

function historyEvent(id: string, changeGroupId: string): EventEnvelope {
  return parseEventEnvelope({
    id, outlineId: 'outline-1', actorId: 'owner-1', deviceId: 'device-1',
    type: 'document.steps_applied', eventVersion: 1, documentVersion: 1, schemaEpoch: 1,
    baseRevision: 0, origin: 'desktop', occurredAt: '2026-09-01T12:00:00.000Z', changeGroupId,
    payload: {
      steps: [{ stepType: 'replace', from: 1, to: 1 }],
      inverseSteps: [{ stepType: 'replace', from: 1, to: 1 }],
      beforeHash: 'a'.repeat(64), afterHash: 'b'.repeat(64),
    },
  })
}

function ids(...values: string[]) {
  let index = 0
  return () => values[index++] ?? `id-${index}`
}

function event(id: string): EventEnvelope {
  return parseEventEnvelope({
    id,
    outlineId: 'outline-1',
    actorId: 'owner-1',
    deviceId: 'device-1',
    type: 'shortcut.created',
    eventVersion: 1,
    documentVersion: 1,
    schemaEpoch: 1,
    baseRevision: 0,
    origin: 'desktop',
    occurredAt: '2026-09-04T12:00:00.000Z',
    payload: { shortcut: { id: `shortcut-${id}`, kind: 'node', nodeId: 'root' } },
  })
}

describe('OutlineSession opening', () => {
  it('opens a new local outline and owns its identity and initial checkpoint', async () => {
    const repo = repository()
    const session = new OutlineSession(repo.value, undefined, {
      nextId: ids('checkpoint-1'),
      now: () => '2026-09-04T12:00:00.000Z',
    })

    const opened = await session.open()

    expect(opened.storageBackend).toEqual({ kind: 'local' })
    expect(opened.state.doc).toEqual(expect.objectContaining({ type: 'doc' }))
    expect(await opened.history).toEqual({ undo: [], redo: [] })
    expect(session.context()).toMatchObject({
      outlineId: 'outline-1',
      actorId: 'owner-1',
      deviceId: 'device-1',
      baseRevision: 0,
    })
    expect(session.getSnapshot().syncState).toEqual({ kind: 'local-only' })
    expect(repo.checkpoints).toEqual([expect.objectContaining({
      id: 'checkpoint-1',
      outlineId: 'outline-1',
      localSequence: 0,
      serverRevision: 0,
      createdAt: '2026-09-04T12:00:00.000Z',
    })])
  })

  it('repairs a legacy projection before returning it and seals the repaired checkpoint', async () => {
    const legacyState: OutlineState = {
      schemaEpoch: 1,
      trash: [],
      shortcuts: [],
      doc: {
        type: 'doc',
        content: [{
          type: 'bulletList',
          content: [{
            type: 'listItem',
            attrs: { nodeId: 'legacy', nodeType: 'user', collapsed: false, bulletKind: 'bullet', completed: false },
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Legacy content' }] }],
          }],
        }],
      },
    }
    const repo = repository({
      loadReplayInput: async () => ({
        checkpoint: {
          id: 'checkpoint-old', outlineId: 'outline-1', documentVersion: 1,
          schemaEpoch: 1, localSequence: 5, serverRevision: 0,
          stateJson: JSON.stringify(legacyState), integrityHash: 'a'.repeat(64),
          createdAt: '2026-09-01T12:00:00.000Z',
        },
        state: legacyState,
        events: [],
      }),
      eventsAfter: async () => [{
        localSequence: 5,
        id: 'old-event',
        outlineId: 'outline-1',
        baseRevision: 0,
        serverRevision: null,
        envelope: {},
        status: 'pending',
        supersededBy: null,
        createdAt: '2026-09-01T12:00:00.000Z',
      }],
      append: async (event) => {
        repo.events.push(event as EventEnvelope)
        return 6
      },
    })
    const session = new OutlineSession(repo.value, undefined, {
      nextId: ids('inbox-id', 'daily-notes-id', 'repair-event', 'checkpoint-repaired'),
      now: () => '2026-09-04T12:00:00.000Z',
    })

    const opened = await session.open()

    expect(repo.events).toEqual([expect.objectContaining({
      id: 'repair-event',
      origin: 'migration',
      type: 'document.steps_applied',
    })])
    expect(repo.checkpoints[repo.checkpoints.length - 1]).toEqual(expect.objectContaining({
      id: 'checkpoint-repaired',
      localSequence: 6,
    }))
    expect(JSON.stringify(opened.state.doc)).toContain('Legacy content')
    expect(JSON.stringify(opened.state.doc)).toContain('inbox')
    expect(await opened.history).toEqual({ undo: [], redo: [] })
  })

  it('starts empty at the current event barrier after an unreadable outline', async () => {
    const repo = repository({
      eventsBefore: async () => [{
        localSequence: 9,
        id: 'event-9',
        outlineId: 'outline-1',
        baseRevision: 0,
        serverRevision: null,
        envelope: {},
        status: 'pending',
        supersededBy: null,
        createdAt: '2026-09-01T12:00:00.000Z',
      }],
    })
    const session = new OutlineSession(repo.value, undefined, {
      nextId: ids('checkpoint-empty'),
      now: () => '2026-09-04T12:00:00.000Z',
    })

    const opened = await session.startEmpty()

    expect(opened.state.doc).toEqual(EMPTY_DOC)
    expect(repo.checkpoints).toEqual([expect.objectContaining({
      id: 'checkpoint-empty',
      localSequence: 9,
    })])
  })
  it('rebuilds history from bounded pages instead of reading the whole event log', async () => {
    const reads: Array<{ before: number; limit: number }> = []
    const log = [
      { sequence: 1, envelope: historyEvent('old-edit', 'old-group') },
      { sequence: 2, envelope: historyEvent('boundary', 'system:daily-note') },
      { sequence: 3, envelope: historyEvent('recent-edit', 'recent-group') },
    ]
    const checkpointState: OutlineState = {
      doc: EMPTY_DOC as unknown as OutlineState['doc'], trash: [], shortcuts: [], schemaEpoch: 1,
    }
    const repo = repository({
      loadReplayInput: async () => ({
        checkpoint: {
          id: 'checkpoint-1', outlineId: 'outline-1', documentVersion: 1, schemaEpoch: 1,
          localSequence: 3, serverRevision: 0, stateJson: JSON.stringify(checkpointState),
          integrityHash: 'a'.repeat(64), createdAt: '2026-09-01T12:00:00.000Z',
        },
        state: checkpointState,
        events: [],
        latestLocalSequence: 3,
      }),
      eventsAfter: async () => { throw new Error('the full event log must not be read on open') },
      eventsBefore: async (_outlineId, before, limit) => {
        reads.push({ before, limit })
        return log
          .filter((entry) => entry.sequence <= before)
          .slice(-limit)
          .map((entry) => ({
            localSequence: entry.sequence, id: entry.envelope.id, outlineId: 'outline-1',
            baseRevision: 0, serverRevision: null, envelope: entry.envelope,
            status: 'pending' as const, supersededBy: null, createdAt: '2026-09-01T12:00:00.000Z',
          }))
      },
    })
    const session = new OutlineSession(repo.value, undefined, {
      nextId: ids('unused'), now: () => '2026-09-04T12:00:00.000Z',
    })

    const opened = await session.open()

    expect(await opened.history).toMatchObject({ undo: [{ id: 'recent-group' }], redo: [] })
    expect(reads).toHaveLength(1)
    expect(reads[0].before).toBe(3)
  })

  it('paints a cached server outline without waiting for the network', async () => {
    const state = createInitialOutlineStateForTest()
    let syncCalls = 0
    const repo = repository({
      storageMode: async () => 'server',
      serverConnection: async () => ({
        origin: 'https://forage.example', instanceId: 'server-1', outlineId: 'outline-1',
      }),
      loadReplayInput: async () => ({
        checkpoint: {
          id: 'checkpoint-1', outlineId: 'outline-1', documentVersion: 1, schemaEpoch: 1,
          localSequence: 4, serverRevision: 2, stateJson: JSON.stringify(state),
          integrityHash: 'a'.repeat(64), createdAt: '2026-09-04T12:00:00.000Z',
        },
        state,
        events: [],
        latestLocalSequence: 4,
      }),
    })
    const session = new OutlineSession(repo.value, undefined, {
      createSyncEngine: (onState) => ({
        state: { kind: 'offline' },
        historyInvalidated: false,
        async sync() {
          syncCalls += 1
          this.state = { kind: 'up-to-date', revision: 2 }
          onState(this.state)
        },
      }),
    })

    const opened = await session.open()

    expect(syncCalls).toBe(0)
    expect(opened.storageBackend).toEqual({ kind: 'server', origin: 'https://forage.example' })
    expect(session.getSnapshot().syncState).toEqual({ kind: 'connecting' })
    expect(opened.state.doc).toEqual(state.doc)
  })

  it('paints the outline before the undo history has been read', async () => {
    const state = createInitialOutlineStateForTest()
    let releaseHistory = () => {}
    const historyRead = new Promise<void>((resolve) => { releaseHistory = resolve })
    const repo = repository({
      loadReplayInput: async () => ({
        checkpoint: {
          id: 'checkpoint-1', outlineId: 'outline-1', documentVersion: 1, schemaEpoch: 1,
          localSequence: 4, serverRevision: 0, stateJson: JSON.stringify(state),
          integrityHash: 'a'.repeat(64), createdAt: '2026-09-04T12:00:00.000Z',
        },
        state,
        events: [],
        latestLocalSequence: 4,
        acknowledgedSequence: 4,
      }),
      eventsBefore: async () => {
        await historyRead
        return [{
          localSequence: 3, id: 'edit', outlineId: 'outline-1', baseRevision: 0,
          serverRevision: null, envelope: historyEvent('edit', 'typed'),
          status: 'accepted' as const, supersededBy: null, createdAt: '2026-09-04T12:00:00.000Z',
        }]
      },
    })
    const session = new OutlineSession(repo.value)

    const opened = await session.open()

    expect(opened.state).toBeTruthy()
    releaseHistory()
    expect(await opened.history).toMatchObject({ undo: [{ id: 'typed' }] })
  })

  it('records a recovery checkpoint for the events it replayed on open', async () => {
    const state = createInitialOutlineStateForTest()
    const repo = repository({
      storageMode: async () => 'server',
      serverConnection: async () => ({
        origin: 'https://forage.example', instanceId: 'server-1', outlineId: 'outline-1',
      }),
      loadReplayInput: async () => ({
        checkpoint: {
          id: 'checkpoint-1', outlineId: 'outline-1', documentVersion: 1, schemaEpoch: 1,
          localSequence: 4, serverRevision: 2, stateJson: JSON.stringify(state),
          integrityHash: 'a'.repeat(64), createdAt: '2026-09-04T12:00:00.000Z',
        },
        state,
        events: [event('a'), event('b')],
        latestLocalSequence: 6,
        acknowledgedSequence: 6,
      }),
    })
    const session = new OutlineSession(repo.value, undefined, { nextId: ids('checkpoint-2') })

    await session.open()
    expect(repo.checkpoints).toHaveLength(0)
    await session.backgroundWork()

    expect(repo.checkpoints).toMatchObject([{ localSequence: 6, serverRevision: 2 }])
  })

  it('leaves unacknowledged edits out of the recovery checkpoint it records on open', async () => {
    const state = createInitialOutlineStateForTest()
    const repo = repository({
      storageMode: async () => 'server',
      serverConnection: async () => ({
        origin: 'https://forage.example', instanceId: 'server-1', outlineId: 'outline-1',
      }),
      loadReplayInput: async () => ({
        checkpoint: {
          id: 'checkpoint-1', outlineId: 'outline-1', documentVersion: 1, schemaEpoch: 1,
          localSequence: 4, serverRevision: 2, stateJson: JSON.stringify(state),
          integrityHash: 'a'.repeat(64), createdAt: '2026-09-04T12:00:00.000Z',
        },
        state,
        events: [event('a'), event('b')],
        latestLocalSequence: 6,
        acknowledgedSequence: 5,
      }),
    })
    const session = new OutlineSession(repo.value, undefined, { nextId: ids('checkpoint-2') })

    await session.open()
    await session.backgroundWork()

    expect(repo.checkpoints).toHaveLength(0)
  })

  it('waits for the first sync when a server outline has nothing cached to show', async () => {
    const state = createInitialOutlineStateForTest()
    let syncCalls = 0
    let pulled = false
    const repo = repository({
      storageMode: async () => 'server',
      serverConnection: async () => ({
        origin: 'https://forage.example', instanceId: 'server-1', outlineId: 'outline-1',
      }),
      loadReplayInput: async () => pulled ? {
        checkpoint: {
          id: 'checkpoint-1', outlineId: 'outline-1', documentVersion: 1, schemaEpoch: 1,
          localSequence: 4, serverRevision: 2, stateJson: JSON.stringify(state),
          integrityHash: 'a'.repeat(64), createdAt: '2026-09-04T12:00:00.000Z',
        },
        state,
        events: [],
        latestLocalSequence: 4,
      } : null,
    })
    const session = new OutlineSession(repo.value, undefined, {
      nextId: ids('inbox-id', 'daily-notes-id', 'checkpoint-genesis'),
      createSyncEngine: (onState) => ({
        state: { kind: 'offline' },
        historyInvalidated: false,
        async sync() {
          syncCalls += 1
          pulled = true
          this.state = { kind: 'up-to-date', revision: 2 }
          onState(this.state)
        },
      }),
    })

    const opened = await session.open()

    expect(syncCalls).toBe(1)
    expect(opened.state.doc).toEqual(state.doc)
  })
})

describe('OutlineSession persistence', () => {
  it('does not notify React subscribers when a status value is unchanged', () => {
    const session = new OutlineSession(repository().value)
    let notifications = 0
    const unsubscribe = session.subscribe(() => { notifications += 1 })

    session.dismissSaveError()
    session.dismissMaintenanceError()
    unsubscribe()

    expect(notifications).toBe(0)
  })

  it('publishes status changes to subscribers and stops after unsubscribe', async () => {
    const repo = repository({
      append: async () => { throw new Error('disk unavailable') },
    })
    const session = new OutlineSession(repo.value)
    await session.open()
    const snapshots: string[] = []
    const unsubscribe = session.subscribe(() => {
      snapshots.push(session.getSnapshot().saveError ?? 'clear')
    })

    await session.append(event('event-1'))
    unsubscribe()
    session.dismissSaveError()

    expect(snapshots).toContain('disk unavailable')
    expect(snapshots[snapshots.length - 1]).toBe('disk unavailable')
    expect(session.getSnapshot().saveError).toBeNull()
  })

  it('finalizes captured editor changes before appending them', async () => {
    const repo = repository()
    const session = new OutlineSession(repo.value)
    await session.open()
    const schema = createOutlineSchema()
    const before = schema.nodeFromJSON(EMPTY_DOC as object)
    let insertionPosition = 1
    before.descendants((node, position) => {
      if (node.isTextblock && insertionPosition === 1) insertionPosition = position + 1
    })
    const transaction = EditorState.create({ doc: before }).tr.insertText('changed', insertionPosition)
    const captured = captureDocumentEvent(transaction, [], {
      outlineId: 'outline-1',
      actorId: 'owner-1',
      deviceId: 'device-1',
      baseRevision: 0,
      nextEventId: () => 'document-event',
      nextChangeGroupId: () => 'change-1',
      now: () => '2026-09-04T12:00:00.000Z',
    })
    expect(captured).not.toBeNull()

    await session.persistCaptured(captured!)

    expect(repo.events).toEqual([expect.objectContaining({
      id: 'document-event',
      type: 'document.steps_applied',
      payload: expect.objectContaining({
        beforeHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        afterHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    })])
  })

  it('keeps new events behind an in-flight retry without changing FIFO order', async () => {
    let attempt = 0
    let releaseRetry!: () => void
    let announceRetry!: () => void
    const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve })
    const retryStarted = new Promise<void>((resolve) => { announceRetry = resolve })
    const successful: EventEnvelope[] = []
    const repo = repository({
      append: async (candidate) => {
        attempt += 1
        if (attempt === 1) throw new Error('disk temporarily unavailable')
        if (attempt === 2) {
          announceRetry()
          await retryGate
        }
        successful.push(candidate as EventEnvelope)
        return successful.length
      },
    })
    const session = new OutlineSession(repo.value)
    await session.open()

    await session.append(event('event-1'))
    expect(session.getSnapshot().saveError).toBe('disk temporarily unavailable')
    const second = session.append(event('event-2'))
    const retry = session.retrySave()
    await retryStarted
    const third = session.append(event('event-3'))
    releaseRetry()
    await Promise.all([second, retry, third])

    expect(successful.map((candidate) => candidate.id)).toEqual([
      'event-1',
      'event-2',
      'event-3',
    ])
    expect(session.getSnapshot().saveError).toBeNull()
  })

  it('reports a failed periodic checkpoint without blocking later event appends', async () => {
    const state = createInitialOutlineStateForTest()
    let opened = false
    let sequence = 99
    let checkpointAttempts = 0
    const appended: EventEnvelope[] = []
    const repo = repository({
      loadReplayInput: async () => opened ? {
        checkpoint: {
          id: 'checkpoint-99', outlineId: 'outline-1', documentVersion: 1,
          schemaEpoch: 1, localSequence: 99, serverRevision: 0,
          stateJson: JSON.stringify(state), integrityHash: 'a'.repeat(64),
          createdAt: '2026-09-04T12:00:00.000Z',
        },
        state,
        events: appended,
        latestLocalSequence: sequence,
      } : null,
      eventsAfter: async () => opened ? [{
        localSequence: 99,
        id: 'event-99',
        outlineId: 'outline-1',
        baseRevision: 0,
        serverRevision: null,
        envelope: event('event-99'),
        status: 'pending',
        supersededBy: null,
        createdAt: '2026-09-04T12:00:00.000Z',
      }] : [],
      append: async (candidate) => {
        sequence += 1
        appended.push(candidate as EventEnvelope)
        return sequence
      },
      saveCheckpoint: async () => {
        checkpointAttempts += 1
        if (opened) throw new Error('checkpoint disk unavailable')
      },
    })
    const session = new OutlineSession(repo.value)
    await session.open()
    opened = true

    await session.append(event('event-100'))
    expect(session.getSnapshot()).toMatchObject({
      saveError: null,
      maintenanceError: 'checkpoint disk unavailable',
    })
    session.dismissMaintenanceError()
    expect(session.getSnapshot().maintenanceError).toBeNull()
    await session.append(event('event-101'))

    expect(appended.map((candidate) => candidate.id)).toEqual(['event-100', 'event-101'])
    expect(checkpointAttempts).toBe(2)
    expect(session.getSnapshot().saveError).toBeNull()
  })
})

describe('OutlineSession synchronization', () => {
  it('waits behind pending persistence and returns a normalized projection', async () => {
    const state = createInitialOutlineStateForTest()
    const appliedEvent = event('remote-event')
    let opened = false
    let syncCalls = 0
    let releaseAppend!: () => void
    const appendGate = new Promise<void>((resolve) => { releaseAppend = resolve })
    const repo = repository({
      loadReplayInput: async () => opened ? {
        checkpoint: {
          id: 'checkpoint-1', outlineId: 'outline-1', documentVersion: 1,
          schemaEpoch: 1, localSequence: 1, serverRevision: 7,
          stateJson: JSON.stringify(state), integrityHash: 'a'.repeat(64),
          createdAt: '2026-09-04T12:00:00.000Z',
        },
        state,
        events: [],
        latestLocalSequence: 1,
      } : null,
      append: async () => {
        await appendGate
        return 1
      },
    })
    const session = new OutlineSession(repo.value, undefined, {
      createSyncEngine: (onState) => ({
        state: { kind: 'offline' },
        historyInvalidated: true,
        appliedEvents: [appliedEvent],
        async sync() {
          syncCalls += 1
          this.state = { kind: 'up-to-date', revision: 7 }
          onState(this.state)
        },
      }),
    })
    await session.open()
    opened = true

    const persistence = session.append(event('event-1'))
    const synchronization = session.synchronize()
    await Promise.resolve()
    expect(syncCalls).toBe(0)

    releaseAppend()
    await persistence
    const result = await synchronization

    expect(syncCalls).toBe(1)
    expect(result?.state.doc).toEqual(EMPTY_DOC)
    expect(result?.historyInvalidated).toBe(true)
    expect(result?.appliedEvents).toEqual([appliedEvent])
    expect(session.getSnapshot().syncState).toEqual({ kind: 'up-to-date', revision: 7 })
    expect(session.context()?.baseRevision).toBe(7)
  })

  it('turns an unexpected synchronization failure into server-unavailable state', async () => {
    const repo = repository()
    const session = new OutlineSession(repo.value, undefined, {
      createSyncEngine: () => ({
        state: { kind: 'offline' },
        historyInvalidated: false,
        async sync() { throw new Error('network vanished') },
      }),
    })
    await session.open()

    const result = await session.synchronize()

    expect(result).toBeNull()
    expect(session.getSnapshot().syncState).toEqual({
      kind: 'server-unavailable',
      message: 'network vanished',
    })
  })

  it('publishes whether the server offers a stream, and keeps the last answer', async () => {
    const repo = repository()
    let supported: boolean | null = true
    const session = new OutlineSession(repo.value, undefined, {
      createSyncEngine: (onState) => ({
        state: { kind: 'offline' }, historyInvalidated: false,
        get streamSupported() { return supported },
        async sync() {
          this.state = { kind: 'up-to-date', revision: 1 }
          onState(this.state)
        },
      }),
    })
    await session.open()
    expect(session.getSnapshot().streamSupported).toBeNull()

    await session.synchronize()
    expect(session.getSnapshot().streamSupported).toBe(true)

    // An engine that never reached the status endpoint must not erase it.
    supported = null
    await session.synchronize()
    expect(session.getSnapshot().streamSupported).toBe(true)

    supported = false
    await session.synchronize()
    expect(session.getSnapshot().streamSupported).toBe(false)
  })

  it('lets an agent sync barrier wait for synchronization already in progress', async () => {
    const repo = repository()
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    let syncCalls = 0
    const session = new OutlineSession(repo.value, undefined, {
      createSyncEngine: (onState) => ({
        state: { kind: 'offline' }, historyInvalidated: false,
        async sync() {
          syncCalls += 1
          await blocked
          this.state = { kind: 'up-to-date', revision: 1 }
          onState(this.state)
        },
      }),
    })
    await session.open()

    const background = session.synchronize()
    const barrier = session.synchronize()
    release()

    await expect(barrier).resolves.toEqual(await background)
    expect(syncCalls).toBe(1)
  })

  it('reports projection-application failures through synchronization status', async () => {
    const state = createInitialOutlineStateForTest()
    let opened = false
    const repo = repository({
      loadReplayInput: async () => opened ? {
        checkpoint: {
          id: 'checkpoint-1', outlineId: 'outline-1', documentVersion: 1,
          schemaEpoch: 1, localSequence: 0, serverRevision: 3,
          stateJson: JSON.stringify(state), integrityHash: 'a'.repeat(64),
          createdAt: '2026-09-04T12:00:00.000Z',
        },
        state,
        events: [],
      } : null,
    })
    const session = new OutlineSession(repo.value, undefined, {
      createSyncEngine: (onState) => ({
        state: { kind: 'offline' },
        historyInvalidated: false,
        async sync() {
          this.state = { kind: 'up-to-date', revision: 3 }
          onState(this.state)
        },
      }),
    })
    await session.open()
    opened = true

    const result = await session.synchronize(() => {
      throw new Error('projection rejected')
    })

    expect(result).toBeNull()
    expect(session.getSnapshot().syncState).toEqual({
      kind: 'server-unavailable',
      message: 'projection rejected',
    })
  })
})

function createInitialOutlineStateForTest(): OutlineState {
  return {
    doc: EMPTY_DOC as Record<string, unknown>,
    trash: [],
    shortcuts: [],
    schemaEpoch: 1,
  }
}
