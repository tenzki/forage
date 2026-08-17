import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { BulletAttributes, OutlinerKeymap } from './extensions'
import {
  collectBullets,
  duplicateBullet,
  moveBulletById,
  moveBulletTo,
  restoreBullet,
  trashBullet,
} from './outlineModel'
import {
  OutlinerUi,
  setAgentActivity,
  setZoom,
  toggleCollapsed,
} from './outlinerUi'

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

  it('shows agent activity as transient decoration instead of document content', () => {
    const beforeText = editor.state.doc.textContent

    const cancel = vi.fn()
    setAgentActivity(editor, 'bravo', ['fetching: lambdaworks.io'], cancel)

    expect(editor.view.dom.querySelector('.agent-activity-line')?.textContent).toBe('fetching: lambdaworks.io')
    expect(editor.state.doc.textContent).toBe(beforeText)
    expect(editor.state.doc.textContent).not.toContain('fetching')
    const stopButton = editor.view.dom.querySelector('.agent-stop') as HTMLButtonElement
    stopButton.click()
    expect(cancel).toHaveBeenCalledOnce()
    setAgentActivity(editor, 'bravo', null)
    expect(editor.view.dom.querySelector('.agent-activity')).toBeNull()
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

  it('pointer-drags a bullet over the target row to re-nest it', () => {
    const source = editor.view.dom.querySelector('[data-node-id="bravo"] > .bullet-controls .bullet-dot') as HTMLButtonElement
    const target = editor.view.dom.querySelector('[data-node-id="alpha-child"]') as HTMLElement
    const targetText = target.querySelector(':scope > p') as HTMLElement
    targetText.getBoundingClientRect = () => ({ top: 0, height: 30 } as DOMRect)
    const hitTest = vi.spyOn(document, 'elementFromPoint').mockReturnValue(targetText)

    source.dispatchEvent(new MouseEvent('pointerdown', {
      bubbles: true, cancelable: true, button: 0, clientX: 0, clientY: 0,
    }))
    document.dispatchEvent(new MouseEvent('pointermove', {
      bubbles: true, cancelable: true, clientX: 10, clientY: 15,
    }))
    const preview = document.querySelector('.outline-drop-preview') as HTMLElement
    expect(source.closest('li')?.classList.contains('is-drag-source')).toBe(true)
    expect(target.dataset.dropPlacement).toBe('inside')
    expect(preview.hidden).toBe(false)
    expect(preview.dataset.placement).toBe('inside')
    expect(preview.textContent).toContain('Bravo')
    document.dispatchEvent(new MouseEvent('pointerup', {
      bubbles: true, cancelable: true, clientX: 10, clientY: 15,
    }))
    hitTest.mockRestore()

    expect(document.querySelector('.outline-drop-preview')).toBeNull()
    expect(collectBullets(editor.state.doc).find((entry) => entry.id === 'bravo')?.ancestorIds).toEqual([
      'alpha',
      'alpha-child',
    ])
  })

  it('moves a branch across parents and undoes it in one step', () => {
    expect(moveBulletTo(editor, 'bravo', 'alpha', 'inside')).toBe(true)
    const bravo = collectBullets(editor.state.doc).find((entry) => entry.id === 'bravo')
    expect(bravo?.ancestorIds).toEqual(['alpha'])

    editor.commands.undo()
    expect(collectBullets(editor.state.doc).find((entry) => entry.id === 'bravo')?.ancestorIds).toEqual([])
  })

  it('prevents moving a branch inside its own descendant', () => {
    const before = editor.state.doc.toJSON()
    expect(moveBulletTo(editor, 'alpha', 'alpha-child', 'inside')).toBe(false)
    expect(editor.state.doc.toJSON()).toEqual(before)
  })

  it('duplicates a complete branch with fresh ids', () => {
    expect(duplicateBullet(editor, 'alpha')).toBe(true)
    const entries = collectBullets(editor.state.doc)
    const alphaCopies = entries.filter((entry) => entry.text === 'Alpha')
    const childCopies = entries.filter((entry) => entry.text === 'Alpha child')
    expect(alphaCopies).toHaveLength(2)
    expect(childCopies).toHaveLength(2)
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(entries.length)
  })

  it('moves a deleted branch to trash and restores its original parent', () => {
    const deleted = trashBullet(editor, 'alpha-child')
    expect(deleted?.originalParentId).toBe('alpha')
    expect(collectBullets(editor.state.doc).some((entry) => entry.id === 'alpha-child')).toBe(false)
    expect(deleted && restoreBullet(editor, deleted)).toBe(true)
    expect(collectBullets(editor.state.doc).find((entry) => entry.id === 'alpha-child')?.ancestorIds).toEqual(['alpha'])
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
