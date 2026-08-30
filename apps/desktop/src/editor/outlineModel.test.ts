import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { BulletAttributes, OutlinerKeymap } from './extensions'
import { BulletNote, focusOrCreateBulletNote, hasBulletNote } from './bulletNote'
import { InternalLink } from './internalLinks'
import {
  collectBullets,
  duplicateBullet,
  moveBulletById,
  moveBulletTo,
  restoreBullet,
  searchBullets,
  setBulletKind,
  toggleBulletCompleted,
  trashBullet,
} from './outlineModel'
import {
  OutlinerUi,
  setAgentActivity,
  setHideCompleted,
  setZoom,
  toggleCollapsed,
} from './outlinerUi'

function item(id: string, text: string, children: object[] = []) {
  return {
    type: 'listItem',
    attrs: {
      nodeId: id,
      nodeType: 'user',
      collapsed: false,
      bulletKind: 'bullet',
      completed: false,
    },
    content: [
      { type: 'paragraph', content: [{ type: 'text', text }] },
      ...(children.length ? [{ type: 'bulletList', content: children }] : []),
    ],
  }
}

function linkedItem(id: string, text: string, targetId: string) {
  return {
    type: 'listItem',
    attrs: {
      nodeId: id,
      nodeType: 'user',
      collapsed: false,
      bulletKind: 'bullet',
      completed: false,
    },
    content: [{
      type: 'paragraph',
      content: [{ type: 'text', text, marks: [{ type: 'internalLink', attrs: { targetId } }] }],
    }],
  }
}

function makeEditor(): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit.configure({ trailingNode: false }), BulletAttributes, BulletNote, InternalLink, OutlinerKeymap, OutlinerUi],
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

  it('keeps one editable bullet when all outline data is deleted', () => {
    editor.commands.selectAll()
    editor.commands.keyboardShortcut('Backspace')

    const bullets = collectBullets(editor.state.doc)
    expect(editor.state.doc.childCount).toBe(1)
    expect(editor.state.doc.firstChild?.type.name).toBe('bulletList')
    expect(bullets).toHaveLength(1)
    expect(bullets[0].text).toBe('')
  })

  it('tracks stable hierarchy paths for breadcrumbs and search scope', () => {
    const child = collectBullets(editor.state.doc).find((entry) => entry.id === 'alpha-child')
    expect(child?.ancestorIds).toEqual(['alpha'])
  })

  it('ranks shallower and more-referenced search results higher', () => {
    editor.commands.setContent({
      type: 'doc',
      content: [{
        type: 'bulletList',
        content: [
          item('shallow', 'Topic shallow'),
          item('container', 'Container', [
            item('popular', 'Topic popular'),
            item('deep', 'Topic deep'),
          ]),
          linkedItem('source-one', 'First reference', 'popular'),
          linkedItem('source-two', 'Second reference', 'popular'),
        ],
      }],
    })

    expect(searchBullets(collectBullets(editor.state.doc), 'Topic').map((entry) => entry.id))
      .toEqual(['popular', 'shallow', 'deep'])
  })

  it('indents and outdents with Tab and Shift+Tab', () => {
    const bravo = collectBullets(editor.state.doc).find((entry) => entry.id === 'bravo')!
    editor.commands.setTextSelection(bravo.pos + 2)

    editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Tab', bubbles: true, cancelable: true,
    }))
    expect(collectBullets(editor.state.doc).find((entry) => entry.id === 'bravo')?.ancestorIds).toEqual(['alpha'])

    editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Tab', shiftKey: true, bubbles: true, cancelable: true,
    }))
    expect(collectBullets(editor.state.doc).find((entry) => entry.id === 'bravo')?.ancestorIds).toEqual([])
  })

  it('inserts a new first child when Enter follows an expanded parent', () => {
    let parentEnd = -1
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'listItem' && node.attrs.nodeId === 'alpha') {
        parentEnd = pos + 2 + node.firstChild!.content.size
        return false
      }
      return undefined
    })
    editor.commands.setTextSelection(parentEnd)

    editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true, cancelable: true,
    }))

    const alpha = collectBullets(editor.state.doc).find((entry) => entry.id === 'alpha')!.node
    const children = alpha.child(1)
    expect(children.childCount).toBe(2)
    expect(children.child(0).textContent).toBe('')
    expect(children.child(1).textContent).toBe('Alpha child')
    expect(editor.state.selection.$from.parent.textContent).toBe('')
  })

  it('inserts a visible sibling after a collapsed parent when Enter follows it', () => {
    expect(toggleCollapsed(editor, 'alpha')).toBe(true)
    let parentEnd = -1
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'listItem' && node.attrs.nodeId === 'alpha') {
        parentEnd = pos + 2 + node.firstChild!.content.size
        return false
      }
      return undefined
    })
    editor.commands.setTextSelection(parentEnd)

    editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true, cancelable: true,
    }))

    const rootList = editor.state.doc.firstChild!
    expect(rootList.childCount).toBe(4)
    expect(rootList.child(0).attrs.nodeId).toBe('alpha')
    expect(rootList.child(0).child(1).child(0).textContent).toBe('Alpha child')
    expect(rootList.child(1).textContent).toBe('')
    expect(rootList.child(2).attrs.nodeId).toBe('bravo')
    expect(editor.state.selection.$from.parent.textContent).toBe('')
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

  it('converts bullets to todos and toggles completion with undo support', () => {
    expect(setBulletKind(editor, 'bravo', 'todo')).toBe(true)
    expect(collectBullets(editor.state.doc).find((entry) => entry.id === 'bravo')).toMatchObject({
      bulletKind: 'todo',
      completed: false,
    })
    const checkbox = editor.view.dom.querySelector('[data-node-id="bravo"] .todo-checkbox') as HTMLButtonElement
    expect(checkbox.getAttribute('aria-checked')).toBe('false')
    checkbox.click()
    expect(collectBullets(editor.state.doc).find((entry) => entry.id === 'bravo')?.completed).toBe(true)

    editor.commands.undo()
    expect(collectBullets(editor.state.doc).find((entry) => entry.id === 'bravo')?.completed).toBe(false)
  })

  it('cycles bullet, open todo, and completed todo with Mod-Enter', () => {
    const bravo = collectBullets(editor.state.doc).find((entry) => entry.id === 'bravo')!
    editor.commands.setTextSelection(bravo.pos + 2)

    editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true,
    }))
    expect(collectBullets(editor.state.doc).find((entry) => entry.id === 'bravo')).toMatchObject({
      bulletKind: 'todo', completed: false,
    })

    editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true,
    }))
    expect(collectBullets(editor.state.doc).find((entry) => entry.id === 'bravo')).toMatchObject({
      bulletKind: 'todo', completed: true,
    })

    editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true,
    }))
    expect(collectBullets(editor.state.doc).find((entry) => entry.id === 'bravo')).toMatchObject({
      bulletKind: 'bullet', completed: false,
    })
  })

  it('filters todos by completion status and can hide completed rows', () => {
    setBulletKind(editor, 'bravo', 'todo')
    setBulletKind(editor, 'charlie', 'todo')
    toggleBulletCompleted(editor, 'charlie')
    const entries = collectBullets(editor.state.doc)

    expect(searchBullets(entries, 'is:todo').map((entry) => entry.id)).toEqual(['bravo', 'charlie'])
    expect(searchBullets(entries, 'is:open').map((entry) => entry.id)).toEqual(['bravo'])
    expect(searchBullets(entries, 'is:complete').map((entry) => entry.id)).toEqual(['charlie'])

    setHideCompleted(editor, true)
    expect(editor.view.dom.querySelector('[data-node-id="charlie"]')?.classList.contains('is-completed-hidden')).toBe(true)
    setHideCompleted(editor, false)
    expect(editor.view.dom.querySelector('[data-node-id="charlie"]')?.classList.contains('is-completed-hidden')).toBe(false)
  })

  it('keeps an editable node note with duplicate, Trash, and restore operations', () => {
    expect(focusOrCreateBulletNote(editor, 'bravo')).toBe(true)
    expect(editor.commands.insertContent('Secondary detail')).toBe(true)
    expect(collectBullets(editor.state.doc).find((entry) => entry.id === 'bravo')?.noteText).toBe('Secondary detail')

    expect(duplicateBullet(editor, 'bravo')).toBe(true)
    expect(collectBullets(editor.state.doc).filter((entry) => entry.noteText === 'Secondary detail')).toHaveLength(2)
    const deleted = trashBullet(editor, 'bravo')
    expect(deleted && restoreBullet(editor, deleted)).toBe(true)
    expect(collectBullets(editor.state.doc).find((entry) => entry.id === 'bravo')?.noteText).toBe('Secondary detail')
  })

  it('removes an empty note without restructuring its parent bullet', () => {
    expect(focusOrCreateBulletNote(editor, 'bravo')).toBe(true)
    expect(hasBulletNote(editor, 'bravo')).toBe(true)

    editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Backspace', bubbles: true, cancelable: true,
    }))

    const bravo = collectBullets(editor.state.doc).find((entry) => entry.id === 'bravo')
    expect(hasBulletNote(editor, 'bravo')).toBe(false)
    expect(bravo?.ancestorIds).toEqual([])
    expect(bravo?.text).toBe('Bravo')
    expect(editor.state.selection.$from.parent.type.name).toBe('paragraph')
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
