import { describe, expect, it } from 'vitest'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import { createOutlineSchema } from '@forage/document'
import { buildDocumentEvent } from './eventCapture'

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
    expect(event?.payload.steps).toHaveLength(2)
    expect(event?.payload.inverseSteps).toHaveLength(2)
    expect(event?.changeGroupId).toBe('change-1')
  })
})
