import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { BulletAttributes, OutlinerKeymap } from './extensions'
import { collectBullets, moveBulletById } from './outlineModel'
import { OutlinerUi, setZoom, toggleCollapsed } from './outlinerUi'

function item(id: string, text: string, children: object[] = []) {
  return {
    type: 'listItem',
    attrs: { nodeId: id, nodeType: 'user', collapsed: false },
    content: [
      { type: 'paragraph', content: [{ type: 'text', text }] },
      ...(children.length ? [{ type: 'bulletList', content: children }] : []),
    ],
  }
}

function makeEditor(): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit, BulletAttributes, OutlinerKeymap, OutlinerUi],
    content: {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            item('alpha', 'Alpha', [item('alpha-child', 'Alpha child')]),
            item('bravo', 'Bravo'),
            item('charlie', 'Charlie'),
          ],
        },
      ],
    },
  })
}

describe('Workflowy-style outline interactions', () => {
  let editor: Editor

  beforeEach(() => {
    editor = makeEditor()
  })

  afterEach(() => {
    editor.destroy()
  })

  it('tracks stable hierarchy paths for breadcrumbs and search scope', () => {
    const child = collectBullets(editor.state.doc).find((entry) => entry.id === 'alpha-child')
    expect(child?.ancestorIds).toEqual(['alpha'])
  })

  it('moves a whole branch between siblings as one undoable operation', () => {
    expect(moveBulletById(editor, 'charlie', -1)).toBe(true)
    expect(collectBullets(editor.state.doc).map((entry) => entry.id)).toEqual([
      'alpha',
      'alpha-child',
      'charlie',
      'bravo',
    ])

    editor.commands.undo()
    expect(collectBullets(editor.state.doc).map((entry) => entry.id)).toEqual([
      'alpha',
      'alpha-child',
      'bravo',
      'charlie',
    ])
  })

  it('collapses a branch without removing its children', () => {
    expect(toggleCollapsed(editor, 'alpha')).toBe(true)
    const alpha = collectBullets(editor.state.doc).find((entry) => entry.id === 'alpha')
    expect(alpha?.node.attrs.collapsed).toBe(true)
    expect(collectBullets(editor.state.doc).some((entry) => entry.id === 'alpha-child')).toBe(true)
  })

  it('hoists a branch while retaining the single document', () => {
    setZoom(editor, 'alpha')
    const hidden = editor.view.dom.querySelector('[data-node-id="bravo"]')
    const child = editor.view.dom.querySelector('[data-node-id="alpha-child"]')
    expect(hidden?.classList.contains('zoom-hidden')).toBe(true)
    expect(child?.classList.contains('zoom-hidden')).toBe(false)
    expect(collectBullets(editor.state.doc)).toHaveLength(4)
  })
})
