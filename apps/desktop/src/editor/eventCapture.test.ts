import { describe, expect, it } from 'vitest'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import { createOutlineSchema } from '@forage/document'
import {
  buildDocumentEvent,
  captureDocumentEvent,
  DOMAIN_MUTATION_META,
  finalizeDocumentEvent,
} from './eventCapture'

const docJson = {
  type: 'doc',
  content: [{
    type: 'bulletList',
    content: [{
      type: 'listItem',
      attrs: { nodeId: 'root', nodeType: 'user', collapsed: false, bulletKind: 'bullet', completed: false },
      content: [{ type: 'paragraph' }],
    }],
  }],
}

const context = {
  outlineId: 'outline-1',
  actorId: 'owner-1',
  deviceId: 'device-1',
  baseRevision: 0,
  nextEventId: () => 'event-1',
  nextChangeGroupId: () => 'change-1',
  now: () => '2026-08-30T12:00:00.000Z',
}

describe('editor event capture', () => {
  it('ignores a selection-only dispatch', async () => {
    const schema = createOutlineSchema()
    const state = EditorState.create({ schema, doc: schema.nodeFromJSON(docJson) })
    const selectionOnly = state.tr.setSelection(TextSelection.create(state.doc, 3))
    expect(await buildDocumentEvent(selectionOnly, [], context)).toBeNull()
  })

  it('ignores a remote projection replacement marked as non-emitting', async () => {
    const schema = createOutlineSchema()
    const state = EditorState.create({ schema, doc: schema.nodeFromJSON(docJson) })
    const transaction = state.tr.insertText('remote', 3).setMeta('preventUpdate', true)
    await expect(buildDocumentEvent(transaction, [], context)).resolves.toBeNull()
  })

  it('stores root and appended normalization steps as one reversible durable event', async () => {
    const schema = createOutlineSchema()
    const state = EditorState.create({ schema, doc: schema.nodeFromJSON(docJson) })
    const root = state.tr.insertText('A', 3)
    const afterRoot = state.apply(root)
    const appended = afterRoot.tr.setNodeMarkup(1, undefined, {
      ...afterRoot.doc.nodeAt(1)?.attrs,
      nodeId: 'normalized-id',
    })

    const event = await buildDocumentEvent(root, [appended], context)

    expect(event?.type).toBe('document.steps_applied')
    if (event?.type !== 'document.steps_applied') throw new Error('Expected a document event')
    expect(event.payload.steps).toHaveLength(2)
    expect(event.payload.inverseSteps).toHaveLength(2)
    expect(event?.changeGroupId).toBe('change-1')
  })

  it('captures ids and inverse steps synchronously before hashing', async () => {
    const schema = createOutlineSchema()
    const state = EditorState.create({ schema, doc: schema.nodeFromJSON(docJson) })
    const root = state.tr.insertText('A', 3)

    const captured = captureDocumentEvent(root, [], context)

    expect(captured).toMatchObject({
      id: 'event-1',
      type: 'document.steps_applied',
      changeGroupId: 'change-1',
      payload: { steps: expect.any(Array), inverseSteps: expect.any(Array) },
    })
    if (captured?.type !== 'document.steps_applied') throw new Error('Expected a document event')
    expect(captured.payload.inverseSteps).toHaveLength(1)
    await expect(finalizeDocumentEvent(captured!)).resolves.toMatchObject({ id: 'event-1' })
  })

  it('captures a trash move and its document removal as one durable event', async () => {
    const schema = createOutlineSchema()
    const state = EditorState.create({ schema, doc: schema.nodeFromJSON(docJson) })
    const root = state.tr.delete(1, state.doc.content.size - 1).setMeta(DOMAIN_MUTATION_META, {
      type: 'trash.entry_added',
      entry: {
        id: 'trash-1',
        deletedAt: '2026-08-30T12:00:00.000Z',
        originalParentId: null,
        originalIndex: 0,
        node: docJson.content[0].content[0],
      },
    })

    const captured = captureDocumentEvent(root, [], context)
    expect(captured).toMatchObject({
      type: 'trash.entry_added',
      payload: { entry: { id: 'trash-1' }, document: { steps: expect.any(Array) } },
    })
    const event = await finalizeDocumentEvent(captured!)
    if (event.type !== 'trash.entry_added') throw new Error('Expected a trash event')
    expect(event.payload.document).toMatchObject({
      beforeHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      afterHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      inverseSteps: expect.any(Array),
    })
  })
})
