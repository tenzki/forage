import { describe, expect, it } from 'vitest'
import { createOutlineSchema } from '@forage/document'
import { normalizeOutlinerDoc } from './emptyDoc'
import type { JsonValue } from '../types/tree'

function ids() {
  const values = ['editable', 'inbox', 'daily']
  return () => values.shift()!
}

describe('fresh outline initialization', () => {
  it('creates canonical roots and one ordinary editable location in one valid document', () => {
    const normalized = normalizeOutlinerDoc({ type: 'doc' }, ids())
    const parsed = createOutlineSchema().nodeFromJSON(normalized)
    const bullets: Array<{ id: string; role: string | null; text: string }> = []
    parsed.descendants((node) => {
      if (node.type.name === 'listItem') {
        bullets.push({ id: node.attrs.nodeId, role: node.attrs.systemRole, text: node.textContent })
      }
    })

    expect(bullets).toEqual([
      { id: 'inbox', role: 'inbox', text: 'Inbox' },
      { id: 'daily', role: 'daily-notes', text: 'Daily Notes' },
      { id: 'editable', role: null, text: '' },
    ])
  })

  it('preserves existing content and repairs roles without allocating an extra editable bullet', () => {
    const normalized = normalizeOutlinerDoc({
      type: 'doc',
      content: [{
        type: 'bulletList',
        content: [{
          type: 'listItem',
          attrs: { nodeId: 'existing', nodeType: 'user', collapsed: false },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Existing' }] }],
        }],
      }],
    }, (() => {
      const values = ['inbox', 'daily']
      return () => values.shift()!
    })())

    const parsed = createOutlineSchema().nodeFromJSON(normalized)
    expect(parsed.textContent).toContain('Existing')
    expect(parsed.textContent).toContain('Inbox')
    expect(parsed.textContent).toContain('Daily Notes')
    expect(parsed.firstChild?.childCount).toBe(3)
  })

  it('preserves root generated-image items while normalizing the outline', () => {
    const assetId = 'a'.repeat(64)
    const normalized = normalizeOutlinerDoc({
      type: 'doc',
      content: [{
        type: 'bulletList',
        content: [
          {
            type: 'listItem', attrs: { nodeId: 'existing' },
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Existing' }] }],
          },
          {
            type: 'generatedImageItem',
            content: [{ type: 'generatedImage', attrs: { assetId, alt: 'Root image' } }],
          },
        ],
      }],
    }, (() => {
      const values = ['inbox', 'daily']
      return () => values.shift()!
    })()) as { content: Array<{ content: Array<{ type: string }> }> }

    expect(normalized.content[0].content.map((node) => node.type)).toContain('generatedImageItem')
    expect(createOutlineSchema().nodeFromJSON(normalized).textContent).toContain('Existing')
  })

  it('wraps an orphan note as an ordinary bullet instead of dropping it', () => {
    const normalized = normalizeOutlinerDoc({
      type: 'doc',
      content: [{
        type: 'bulletNote',
        content: [{ type: 'text', text: 'Orphan detail' }],
      }],
    }, (() => {
      const values = ['orphan', 'inbox', 'daily']
      return () => values.shift()!
    })())
    const parsed = createOutlineSchema().nodeFromJSON(normalized)
    const orphan = parsed.firstChild?.firstChild

    expect(orphan?.attrs.nodeId).toBe('orphan')
    expect(orphan?.child(1).type.name).toBe('bulletNote')
    expect(orphan?.child(1).textContent).toBe('Orphan detail')
  })

  it('merges repeated notes on one bullet into one multiline note', () => {
    const normalized = normalizeOutlinerDoc({
      type: 'doc',
      content: [{
        type: 'bulletList',
        content: [{
          type: 'listItem', attrs: { nodeId: 'existing' }, content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'Existing' }] },
            { type: 'bulletNote', content: [{ type: 'text', text: 'First' }] },
            { type: 'bulletNote', content: [{ type: 'text', text: 'Second' }] },
          ],
        }],
      }],
    }, (() => {
      const values = ['inbox', 'daily']
      return () => values.shift()!
    })())
    const parsed = createOutlineSchema().nodeFromJSON(normalized)
    const existing = parsed.firstChild?.firstChild
    const notes = Array.from({ length: existing?.childCount ?? 0 }, (_, index) => existing!.child(index))
      .filter((node) => node.type.name === 'bulletNote')

    expect(notes).toHaveLength(1)
    expect(notes[0].textBetween(0, notes[0].content.size, '\n', '\n')).toBe('First\nSecond')
  })

  it('does not mutate persisted compatibility JSON while normalizing it', () => {
    const input = {
      type: 'doc', content: [{ type: 'bulletList', content: [{
        type: 'listItem', attrs: { nodeId: 'legacy' }, content: [
          { type: 'paragraph' },
          { type: 'bulletNote', content: [{ type: 'text', text: 'First' }] },
          { type: 'bulletNote', content: [{ type: 'text', text: 'Second' }] },
        ],
      }] }],
    } as JsonValue
    const before = structuredClone(input)

    normalizeOutlinerDoc(input, ids())

    expect(input).toEqual(before)
  })

  it('moves a legacy trailing note before one merged child list', () => {
    const normalized = normalizeOutlinerDoc({
      type: 'doc', content: [{ type: 'bulletList', content: [{
        type: 'listItem', attrs: { nodeId: 'parent' }, content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Parent' }] },
          { type: 'bulletList', content: [{
            type: 'listItem', attrs: { nodeId: 'first-child' }, content: [{ type: 'paragraph' }],
          }] },
          { type: 'bulletNote', content: [{ type: 'text', text: 'Trailing note' }] },
          { type: 'bulletList', content: [{
            type: 'listItem', attrs: { nodeId: 'second-child' }, content: [{ type: 'paragraph' }],
          }] },
        ],
      }] }],
    }, ids())
    const document = createOutlineSchema().nodeFromJSON(normalized)
    const parent = document.firstChild?.firstChild

    expect(() => document.check()).not.toThrow()
    expect(Array.from({ length: parent?.childCount ?? 0 }, (_, index) => parent!.child(index).type.name))
      .toEqual(['paragraph', 'bulletNote', 'bulletList'])
    expect(parent?.lastChild?.childCount).toBe(2)
  })
})
