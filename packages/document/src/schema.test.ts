import { describe, expect, it } from 'vitest'
import { getSchema } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { EditorState } from '@tiptap/pm/state'
import { applySerializedSteps } from './steps'
import {
  BulletNoteSchema,
  GeneratedImageItemSchema,
  GeneratedImageSchema,
  InternalLinkSchema,
  OutlineBulletListSchema,
  StableBulletAttributes,
  createOutlineSchema,
  createReplayOutlineSchema,
} from './schema'

describe('canonical outline schema', () => {
  it('rejects orphan notes outside list items', () => {
    const schema = createOutlineSchema()
    const document = schema.nodeFromJSON({
      type: 'doc',
      content: [{ type: 'bulletNote', content: [{ type: 'text', text: 'Orphan' }] }],
    })
    expect(() => document.check()).toThrow()
  })

  it('rejects more than one note on a list item', () => {
    const schema = createOutlineSchema()
    const document = schema.nodeFromJSON({
      type: 'doc',
      content: [{
        type: 'bulletList',
        content: [{
          type: 'listItem', attrs: { nodeId: 'item' }, content: [
            { type: 'paragraph' },
            { type: 'bulletNote', content: [{ type: 'text', text: 'First' }] },
            { type: 'bulletNote', content: [{ type: 'text', text: 'Second' }] },
          ],
        }],
      }],
    })
    expect(() => document.check()).toThrow()
  })

  it('replays a complete legacy Backspace batch before enforcing the strict list-item shape', () => {
    const content = {
      type: 'doc',
      content: [{
        type: 'bulletList',
        content: [{
          type: 'listItem',
          attrs: { nodeId: 'date', systemRole: 'daily-note', dailyDate: '2026-08-14' },
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'August 14, 2026' }] },
            {
              type: 'bulletList',
              content: [{
                type: 'listItem', attrs: { nodeId: 'empty-child' }, content: [{ type: 'paragraph' }],
              }],
            },
          ],
        }],
      }],
    }
    const legacySchema = getSchema([
        StarterKit.configure({ bulletList: false, trailingNode: false }),
        OutlineBulletListSchema,
        GeneratedImageItemSchema,
        GeneratedImageSchema,
        StableBulletAttributes,
        BulletNoteSchema.extend({ group: 'block' }),
        InternalLinkSchema,
    ])
    const legacyBefore = legacySchema.nodeFromJSON(content)
    // Older list-item commands could temporarily introduce a second paragraph
    // and remove it later in the same transaction. The final document is valid.
    const transaction = EditorState.create({ schema: legacySchema, doc: legacyBefore }).tr
      .insert(19, legacySchema.nodes.paragraph.create())
      .delete(19, 21)
    const steps = transaction.steps.map((step) => step.toJSON())

    expect(steps).toHaveLength(2)
    const strictBefore = createOutlineSchema().nodeFromJSON(content)
    expect(() => applySerializedSteps(strictBefore, steps)).toThrow(/Invalid content for node listItem/)

    const replayed = applySerializedSteps(createReplayOutlineSchema(1).nodeFromJSON(content), steps)
    expect(replayed.toJSON()).toEqual(legacyBefore.toJSON())
    expect(() => createOutlineSchema().nodeFromJSON(replayed.toJSON()).check()).not.toThrow()
  })

  it('reports unsupported replay epochs as an upgrade requirement', () => {
    expect(() => createReplayOutlineSchema(99)).toThrow(/upgrade_required/)
  })
})
