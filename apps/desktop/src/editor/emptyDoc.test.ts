import { describe, expect, it } from 'vitest'
import { createOutlineSchema } from '@forage/document'
import { normalizeOutlinerDoc } from './emptyDoc'

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
      { id: 'editable', role: null, text: '' },
      { id: 'inbox', role: 'inbox', text: 'Inbox' },
      { id: 'daily', role: 'daily-notes', text: 'Daily Notes' },
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
})
