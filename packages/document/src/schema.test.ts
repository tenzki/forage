import { describe, expect, it } from 'vitest'
import { createOutlineSchema } from './schema'

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
})
