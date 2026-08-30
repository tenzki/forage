import { describe, expect, it } from 'vitest'
import { EditorState } from '@tiptap/pm/state'
import { captureStepBatch, createOutlineSchema } from '../../document/src'
import {
  createCheckpoint,
  createInitialOutlineState,
  replayOutlineEvents,
  verifyCheckpoint,
  type EventEnvelope,
} from './index'

const outlineId = 'out-test'

function envelope(
  type: EventEnvelope['type'],
  payload: EventEnvelope['payload'],
  baseRevision: number,
): EventEnvelope {
  return {
    id: `event-${baseRevision + 1}`,
    outlineId,
    actorId: 'owner-test',
    deviceId: 'device-test',
    type,
    eventVersion: 1,
    documentVersion: 1,
    schemaEpoch: 1,
    baseRevision,
    revision: baseRevision + 1,
    origin: 'desktop',
    occurredAt: '2026-08-30T12:00:00.000Z',
    payload,
  } as EventEnvelope
}

describe('deterministic outline replay', () => {
  it('rebuilds the same projected state from a checkpoint and later events', async () => {
    const schema = createOutlineSchema()
    const initial = createInitialOutlineState({
      type: 'doc',
      content: [{
        type: 'bulletList',
        content: [{
          type: 'listItem',
          attrs: { nodeId: 'inbox', nodeType: 'user', collapsed: false, bulletKind: 'bullet', completed: false },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Inbox' }] }],
        }],
      }],
    })
    const document = schema.nodeFromJSON(initial.doc)
    const transaction = EditorState.create({ schema, doc: document }).tr.insertText('!', 8)
    const batch = captureStepBatch(document, transaction.steps)
    const first = envelope('document.steps_applied', {
      ...batch,
      beforeHash: '0'.repeat(64),
      afterHash: '1'.repeat(64),
    }, 0)
    const second = envelope('shortcut.created', {
      shortcut: { id: 'shortcut-1', kind: 'node', nodeId: 'inbox' },
    }, 1)

    const afterFirst = replayOutlineEvents(initial, [first])
    const checkpoint = await createCheckpoint(afterFirst, {
      id: 'checkpoint-1',
      outlineId,
      documentVersion: 1,
      schemaEpoch: 1,
      localSequence: 1,
      serverRevision: 1,
    })
    expect(await verifyCheckpoint(checkpoint)).toBe(true)

    const fromAllEvents = replayOutlineEvents(initial, [first, second])
    const fromCheckpoint = replayOutlineEvents(checkpoint.state, [second])
    expect(fromCheckpoint).toEqual(fromAllEvents)
  })

  it('detects checkpoint corruption before it can replace replayable history', async () => {
    const checkpoint = await createCheckpoint(createInitialOutlineState({ type: 'doc', content: [] }), {
      id: 'checkpoint-1',
      outlineId,
      documentVersion: 1,
      schemaEpoch: 1,
      localSequence: 0,
      serverRevision: 0,
    })

    checkpoint.state.shortcuts.push({ id: 'tampered', kind: 'node', nodeId: 'missing' })
    expect(await verifyCheckpoint(checkpoint)).toBe(false)
  })

  it('projects note.created under the exact stable parent identity', () => {
    const initial = createInitialOutlineState({
      type: 'doc',
      content: [{
        type: 'bulletList',
        content: [{
          type: 'listItem',
          attrs: { nodeId: 'inbox', nodeType: 'user', collapsed: false, bulletKind: 'bullet', completed: false },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Inbox' }] }],
        }],
      }],
    })
    const created = envelope('note.created', {
      noteId: 'external-note', parentId: 'inbox', text: 'Captured externally', source: { application: 'Raycast' },
    }, 0)

    const state = replayOutlineEvents(initial, [created])
    const document = createOutlineSchema().nodeFromJSON(state.doc)
    let parentId: string | null = null
    document.descendants((node, _pos, parent) => {
      if (node.type.name === 'listItem' && node.attrs.nodeId === 'external-note') {
        parentId = parent?.type.name === 'bulletList' ? parent.attrs.nodeId ?? 'nested-list' : null
      }
    })
    expect(document.textContent).toContain('Captured externally')
    expect(JSON.stringify(state.doc)).toContain('"nodeId":"external-note"')
    expect(parentId).toBe('nested-list')
  })

  it('replays edits written after the editor coalesced legacy root lists', () => {
    const schema = createOutlineSchema()
    const item = (id: string, text: string, role: 'inbox' | 'daily-notes') => ({
      type: 'listItem',
      attrs: {
        nodeId: id, nodeType: 'user', collapsed: false, bulletKind: 'bullet', completed: false,
        systemRole: role, dailyDate: null,
      },
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    })
    const inbox = item('inbox', 'Inbox', 'inbox')
    const daily = item('daily', 'Daily Notes', 'daily-notes')
    const initial = createInitialOutlineState({
      type: 'doc',
      content: [
        { type: 'bulletList', content: [inbox] },
        { type: 'bulletList', content: [daily] },
      ],
    })
    const legacyDocument = schema.nodeFromJSON(initial.doc)
    const migrationTransaction = EditorState.create({ schema, doc: legacyDocument }).tr.insertText('!', 8)
    const migration = {
      ...envelope('document.steps_applied', {
        ...captureStepBatch(legacyDocument, migrationTransaction.steps),
        beforeHash: '0'.repeat(64),
        afterHash: '1'.repeat(64),
      }, 0),
      origin: 'migration' as const,
    }
    const normalizedDocument = schema.nodeFromJSON({
      type: 'doc',
      content: [{ type: 'bulletList', content: [
        item('inbox', 'Inbox!', 'inbox'),
        daily,
      ] }],
    })
    let dailyPos = -1
    normalizedDocument.descendants((node, pos) => {
      if (node.type.name === 'listItem' && node.attrs.nodeId === 'daily') dailyPos = pos
    })
    const editTransaction = EditorState.create({ schema, doc: normalizedDocument })
      .tr.insertText('!', dailyPos + 2 + 'Daily Notes'.length)
    const edit = envelope('document.steps_applied', {
      ...captureStepBatch(normalizedDocument, editTransaction.steps),
      beforeHash: '1'.repeat(64),
      afterHash: '2'.repeat(64),
    }, 1)

    const replayed = replayOutlineEvents(initial, [migration, edit])

    expect(schema.nodeFromJSON(replayed.doc).eq(editTransaction.doc)).toBe(true)
    expect((replayed.doc.content as unknown[])).toHaveLength(1)
  })
})
