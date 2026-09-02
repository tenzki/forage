import { describe, expect, it } from 'vitest'
import { EditorState } from '@tiptap/pm/state'
import {
  applySerializedSteps,
  captureStepBatch,
  createOutlineSchema,
  createReplayOutlineSchema,
  documentChangeSteps,
  normalizeStableBulletIds,
  rebaseSerializedSteps,
} from './index'

const emptyOutline = {
  type: 'doc',
  content: [{
    type: 'bulletList',
    content: [{
      type: 'listItem',
      attrs: {
        nodeId: 'note-root',
        nodeType: 'user',
        collapsed: false,
        bulletKind: 'bullet',
        completed: false,
      },
      content: [{ type: 'paragraph' }],
    }],
  }],
}

describe('shared outline document', () => {
  it('derives a minimal step between document projections for synchronization rebase', () => {
    const schema = createOutlineSchema()
    const before = schema.nodeFromJSON(emptyOutline)
    const state = EditorState.create({ schema, doc: before })
    const after = state.apply(state.tr.insertText('remote', 3)).doc
    expect(applySerializedSteps(before, documentChangeSteps(before, after)).eq(after)).toBe(true)
  })

  it('falls back to a closed document replacement when a structural diff has inconsistent open depths', () => {
    const schema = createReplayOutlineSchema(1)
    const before = schema.nodeFromJSON({
      type: 'doc', content: [{ type: 'bulletList', content: [{
        type: 'listItem', attrs: { nodeId: 'date' }, content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'August 14, 2026' }] },
          { type: 'paragraph' },
        ],
      }] }],
    })
    const after = schema.nodeFromJSON({
      type: 'doc', content: [{ type: 'bulletList', content: [{
        type: 'listItem', attrs: { nodeId: 'date' }, content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'August 14, 2026' }] },
        ],
      }] }],
    })

    const steps = documentChangeSteps(before, after)

    expect(applySerializedSteps(before, steps).eq(after)).toBe(true)
  })
  it('captures serializable forward and inverse steps from the same pre-change document', () => {
    const schema = createOutlineSchema()
    const before = schema.nodeFromJSON(emptyOutline)
    const tr = EditorState.create({ schema, doc: before }).tr.insertText('hello', 3)
    const batch = captureStepBatch(before, tr.steps)
    const after = applySerializedSteps(before, batch.steps)
    const restored = applySerializedSteps(after, batch.inverseSteps)

    expect(after.textContent).toBe('hello')
    expect(restored.eq(before)).toBe(true)
  })

  it('repairs missing and duplicate bullet ids deterministically through an injected id source', () => {
    const schema = createOutlineSchema()
    const invalid = schema.nodeFromJSON({
      type: 'doc',
      content: [{
        type: 'bulletList',
        content: [
          { ...emptyOutline.content[0].content[0], attrs: { ...emptyOutline.content[0].content[0].attrs, nodeId: null } },
          emptyOutline.content[0].content[0],
          emptyOutline.content[0].content[0],
        ],
      }],
    })
    const ids = ['note-a', 'note-b']

    const normalized = normalizeStableBulletIds(invalid, () => ids.shift()!)
    const nodeIds: string[] = []
    normalized.doc.descendants((node) => {
      if (node.type.name === 'listItem') nodeIds.push(node.attrs.nodeId)
    })

    expect(nodeIds).toEqual(['note-a', 'note-root', 'note-b'])
    expect(normalized.steps).toHaveLength(2)
  })

  it('rebases a pending local step over an independent remote step without losing either intention', () => {
    const schema = createOutlineSchema()
    const base = schema.nodeFromJSON({
      ...emptyOutline,
      content: [{
        ...emptyOutline.content[0],
        content: [{
          ...emptyOutline.content[0].content[0],
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'abcd' }] }],
        }],
      }],
    })
    const state = EditorState.create({ schema, doc: base })
    const local = captureStepBatch(base, state.tr.insertText('L', 4).steps)
    const remote = captureStepBatch(base, state.tr.insertText('R', 7).steps)

    const rebased = rebaseSerializedSteps(base, local, remote.steps)

    expect(rebased.doc.textContent).toBe('aLbcdR')
    expect(rebased.steps).toHaveLength(1)
    expect(applySerializedSteps(rebased.doc, rebased.inverseSteps).textContent).toBe('abcdR')
  })
})
