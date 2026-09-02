import { describe, expect, it } from 'vitest'
import { EditorState } from '@tiptap/pm/state'
import { captureStepBatch, createOutlineSchema, createReplayOutlineSchema } from '../../document/src'
import {
  createCheckpoint,
  createInitialOutlineState,
  canonicalJson,
  replayOutlineEvents,
  OutlineReplayError,
  sha256HexSync,
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
      beforeHash: sha256HexSync(canonicalJson(document.toJSON())),
      afterHash: sha256HexSync(canonicalJson(transaction.doc.toJSON())),
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

  it('moves a branch into Trash atomically with its document steps', () => {
    const schema = createOutlineSchema()
    const initial = createInitialOutlineState({
      type: 'doc',
      content: [{ type: 'bulletList', content: [
        {
          type: 'listItem', attrs: { nodeId: 'keep' },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Keep' }] }],
        },
        {
          type: 'listItem', attrs: { nodeId: 'remove' },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Remove' }] }],
        },
      ] }],
    })
    const document = schema.nodeFromJSON(initial.doc)
    let removePos = -1
    let removeSize = 0
    document.descendants((node, pos) => {
      if (node.type.name === 'listItem' && node.attrs.nodeId === 'remove') {
        removePos = pos
        removeSize = node.nodeSize
        return false
      }
      return undefined
    })
    const transaction = EditorState.create({ schema, doc: document }).tr.delete(removePos, removePos + removeSize)
    const entry = {
      id: 'trash-1', deletedAt: '2026-08-30T12:00:00.000Z', originalParentId: null,
      originalIndex: 1, node: document.nodeAt(removePos)!.toJSON(),
    }
    const event = envelope('trash.entry_added', {
      entry,
      document: {
        ...captureStepBatch(document, transaction.steps),
        beforeHash: sha256HexSync(canonicalJson(document.toJSON())),
        afterHash: sha256HexSync(canonicalJson(transaction.doc.toJSON())),
      },
    }, 0)

    const projected = replayOutlineEvents(initial, [event])

    expect(schema.nodeFromJSON(projected.doc).textContent).toBe('Keep')
    expect(projected.trash).toEqual([entry])
  })

  it('restores a branch from Trash atomically with its document steps', () => {
    const schema = createOutlineSchema()
    const entry = {
      id: 'trash-1', deletedAt: '2026-08-30T12:00:00.000Z', originalParentId: null,
      originalIndex: 1,
      node: {
        type: 'listItem', attrs: { nodeId: 'restore' },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Restore' }] }],
      },
    }
    const initial = {
      ...createInitialOutlineState({
        type: 'doc', content: [{ type: 'bulletList', content: [{
          type: 'listItem', attrs: { nodeId: 'keep' },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Keep' }] }],
        }] }],
      }),
      trash: [entry],
    }
    const document = schema.nodeFromJSON(initial.doc)
    const restoredItem = schema.nodeFromJSON({
      type: 'doc', content: [{ type: 'bulletList', content: [entry.node] }],
    }).firstChild!.firstChild!
    const insertPos = document.firstChild!.nodeSize - 1
    const transaction = EditorState.create({ schema, doc: document }).tr.insert(insertPos, restoredItem)
    const event = envelope('trash.entry_restored', {
      entryId: entry.id,
      document: {
        ...captureStepBatch(document, transaction.steps),
        beforeHash: sha256HexSync(canonicalJson(document.toJSON())),
        afterHash: sha256HexSync(canonicalJson(transaction.doc.toJSON())),
      },
    }, 0)

    const projected = replayOutlineEvents(initial, [event])

    expect(schema.nodeFromJSON(projected.doc).textContent).toBe('KeepRestore')
    expect(projected.trash).toEqual([])
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
    const normalizedDocument = schema.nodeFromJSON({
      type: 'doc',
      content: [{ type: 'bulletList', content: [
        item('inbox', 'Inbox!', 'inbox'),
        daily,
      ] }],
    })
    const migration = {
      ...envelope('document.steps_applied', {
        ...captureStepBatch(legacyDocument, migrationTransaction.steps),
        beforeHash: sha256HexSync(canonicalJson(legacyDocument.toJSON())),
        afterHash: sha256HexSync(canonicalJson(normalizedDocument.toJSON())),
      }, 0),
      origin: 'migration' as const,
    }
    let dailyPos = -1
    normalizedDocument.descendants((node, pos) => {
      if (node.type.name === 'listItem' && node.attrs.nodeId === 'daily') dailyPos = pos
    })
    const editTransaction = EditorState.create({ schema, doc: normalizedDocument })
      .tr.insertText('!', dailyPos + 2 + 'Daily Notes'.length)
    const edit = envelope('document.steps_applied', {
      ...captureStepBatch(normalizedDocument, editTransaction.steps),
      beforeHash: sha256HexSync(canonicalJson(normalizedDocument.toJSON())),
      afterHash: sha256HexSync(canonicalJson(editTransaction.doc.toJSON())),
    }, 1)

    const replayed = replayOutlineEvents(initial, [migration, edit])

    expect(schema.nodeFromJSON(replayed.doc).eq(editTransaction.doc)).toBe(true)
    expect((replayed.doc.content as unknown[])).toHaveLength(1)
  })

  it('rejects an event whose document hash does not match replay state', () => {
    const schema = createOutlineSchema()
    const initial = createInitialOutlineState({
      type: 'doc', content: [{ type: 'bulletList', content: [{
        type: 'listItem', attrs: { nodeId: 'item' }, content: [{ type: 'paragraph' }],
      }] }],
    })
    const document = schema.nodeFromJSON(initial.doc)
    const transaction = EditorState.create({ schema, doc: document }).tr.insertText('tampered', 3)
    const event = envelope('document.steps_applied', {
      ...captureStepBatch(document, transaction.steps),
      beforeHash: '0'.repeat(64),
      afterHash: sha256HexSync(canonicalJson(transaction.doc.toJSON())),
    }, 0)

    expect(() => replayOutlineEvents(initial, [event])).toThrow(/integrity mismatch before event event-1/)
  })

  it('rejects an event whose projected document does not match its after hash', () => {
    const schema = createOutlineSchema()
    const initial = createInitialOutlineState({
      type: 'doc', content: [{ type: 'bulletList', content: [{
        type: 'listItem', attrs: { nodeId: 'item' }, content: [{ type: 'paragraph' }],
      }] }],
    })
    const document = schema.nodeFromJSON(initial.doc)
    const transaction = EditorState.create({ schema, doc: document }).tr.insertText('tampered', 3)
    const event = envelope('document.steps_applied', {
      ...captureStepBatch(document, transaction.steps),
      beforeHash: sha256HexSync(canonicalJson(document.toJSON())),
      afterHash: '0'.repeat(64),
    }, 0)

    expect(() => replayOutlineEvents(initial, [event])).toThrow(/integrity mismatch after event event-1/)
  })

  it('reports the exact event where replay recovery stopped', () => {
    const initial = createInitialOutlineState({
      type: 'doc', content: [{ type: 'bulletList', content: [{
        type: 'listItem', attrs: { nodeId: 'item' }, content: [{ type: 'paragraph' }],
      }] }],
    })
    const event = envelope('document.steps_applied', {
      steps: [{ stepType: 'replace', from: 3, to: 3, slice: { content: [{ type: 'text', text: 'x' }] } }],
      inverseSteps: [{ stepType: 'replace', from: 3, to: 4 }],
      beforeHash: '0'.repeat(64),
      afterHash: '0'.repeat(64),
    }, 0)

    try {
      replayOutlineEvents(initial, [event])
      expect.fail('replay should fail')
    } catch (error) {
      expect(error).toBeInstanceOf(OutlineReplayError)
      expect(error).toMatchObject({ eventId: 'event-1', eventIndex: 0, schemaEpoch: 1 })
      expect((error as Error).message).toMatch(/integrity mismatch before event event-1/i)
    }
  })

  it('replays a legacy event whose temporary list-item shape is stricter than its final projection', () => {
    const schema = createReplayOutlineSchema(1)
    const document = schema.nodeFromJSON({
      type: 'doc', content: [{ type: 'bulletList', content: [{
        type: 'listItem',
        attrs: { nodeId: 'date', systemRole: 'daily-note', dailyDate: '2026-08-14' },
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'August 14, 2026' }] },
          { type: 'bulletList', content: [{
            type: 'listItem', attrs: { nodeId: 'empty-child' }, content: [{ type: 'paragraph' }],
          }] },
        ],
      }] }],
    })
    const transaction = EditorState.create({ schema, doc: document }).tr
      .insert(19, schema.nodes.paragraph.create())
      .delete(19, 21)
    const hash = sha256HexSync(canonicalJson(document.toJSON()))
    const event = envelope('document.steps_applied', {
      ...captureStepBatch(document, transaction.steps),
      beforeHash: hash,
      afterHash: hash,
    }, 0)

    const replayed = replayOutlineEvents(createInitialOutlineState(document.toJSON()), [event])

    expect(replayed.doc).toEqual(document.toJSON())
    expect(() => createOutlineSchema().nodeFromJSON(replayed.doc).check()).not.toThrow()
  })
})
