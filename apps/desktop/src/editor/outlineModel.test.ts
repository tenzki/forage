import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { BulletAttributes, OutlinerKeymap, setEditorMutationLocked } from './extensions'
import { BulletNote, focusOrCreateBulletNote, hasBulletNote } from './bulletNote'
import { openOrCreateDailyNote } from './dailyNotes'
import { GeneratedImage, GeneratedImageItem, OutlineBulletList, OutlineListItem } from './generatedImage'
import { InternalLink } from './internalLinks'
import {
  collectBullets,
  currentBulletId,
  duplicateBullet,
  moveBulletById,
  moveBulletTo,
  restoreBullet,
  searchBullets,
  setBulletKind,
  toggleBulletCompleted,
  trashBullet,
  updateBulletText,
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

function systemItem(
  id: string,
  text: string,
  role: 'inbox' | 'daily-notes' | 'daily-note',
  children: object[] = [],
  dailyDate: string | null = role === 'daily-note' ? '2026-08-30' : null,
) {
  const value = item(id, text, children)
  return {
    ...value,
    attrs: {
      ...value.attrs,
      systemRole: role,
      dailyDate,
    },
  }
}

function makeEditor(): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: [
      StarterKit.configure({ bulletList: false, listItem: false, trailingNode: false }),
      OutlineListItem,
      OutlineBulletList,
      GeneratedImageItem,
      GeneratedImage,
      BulletAttributes,
      BulletNote,
      InternalLink,
      OutlinerKeymap,
      OutlinerUi,
    ],
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

  it('creates a fresh user bullet after an AI completed todo without copying semantic attrs', () => {
    const bravo = collectBullets(editor.state.doc).find((entry) => entry.id === 'bravo')!
    editor.view.dispatch(editor.state.tr.setNodeMarkup(bravo.pos, undefined, {
      ...bravo.node.attrs,
      nodeType: 'ai',
      collapsed: true,
      bulletKind: 'todo',
      completed: true,
    }))
    const updated = collectBullets(editor.state.doc).find((entry) => entry.id === 'bravo')!
    editor.commands.setTextSelection(updated.pos + 2 + updated.text.length)

    editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true, cancelable: true,
    }))

    const entries = collectBullets(editor.state.doc)
    const created = entries.find((entry) => entry.id !== 'bravo' && entry.siblingIndex === updated.siblingIndex + 1)!
    expect(created).toMatchObject({
      text: '',
      bulletKind: 'bullet',
      completed: false,
    })
    expect(created.node.attrs).toMatchObject({
      nodeType: 'user',
      collapsed: false,
      systemRole: null,
      dailyDate: null,
    })
    expect(currentBulletId(editor)).toBe(created.id)
  })

  it('keeps an attached note on its original bullet when Enter creates a sibling', () => {
    expect(focusOrCreateBulletNote(editor, 'bravo')).toBe(true)
    expect(editor.commands.insertContent('Secondary detail')).toBe(true)
    const bravo = collectBullets(editor.state.doc).find((entry) => entry.id === 'bravo')!
    editor.commands.setTextSelection(bravo.pos + 2 + bravo.text.length)

    editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true, cancelable: true,
    }))

    const entries = collectBullets(editor.state.doc)
    const original = entries.find((entry) => entry.id === 'bravo')!
    const created = entries.find((entry) => entry.id !== 'bravo' && entry.siblingIndex === original.siblingIndex + 1)!
    expect(original.noteText).toBe('Secondary detail')
    expect(created.noteText).toBe('')
    expect(currentBulletId(editor)).toBe(created.id)
  })

  it('expands a collapsed empty system parent before selecting its new child', () => {
    editor.commands.setContent({
      type: 'doc',
      content: [{
        type: 'bulletList',
        content: [systemItem('inbox', 'Inbox', 'inbox')],
      }],
    })
    const inbox = collectBullets(editor.state.doc).find((entry) => entry.id === 'inbox')!
    editor.view.dispatch(editor.state.tr.setNodeMarkup(inbox.pos, undefined, {
      ...inbox.node.attrs,
      collapsed: true,
    }))
    const collapsed = collectBullets(editor.state.doc).find((entry) => entry.id === 'inbox')!
    editor.commands.setTextSelection(collapsed.pos + 2 + collapsed.text.length)

    editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true, cancelable: true,
    }))

    const entries = collectBullets(editor.state.doc)
    const parent = entries.find((entry) => entry.id === 'inbox')!
    const child = entries.find((entry) => entry.ancestorIds[entry.ancestorIds.length - 1] === 'inbox')!
    expect(parent.node.attrs.collapsed).toBe(false)
    expect(currentBulletId(editor)).toBe(child.id)
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

  it('rejects structural and todo mutations on protected system roots', () => {
    editor.commands.setContent({
      type: 'doc',
      content: [{
        type: 'bulletList',
        content: [
          systemItem('inbox', 'Inbox', 'inbox', [item('capture', 'Captured')]),
          systemItem('daily', 'Daily Notes', 'daily-notes', [
            systemItem('today', 'Today', 'daily-note', [item('journal', 'Journal')]),
          ]),
          item('ordinary', 'Ordinary'),
        ],
      }],
    })

    expect(moveBulletTo(editor, 'inbox', 'ordinary', 'inside')).toBe(false)
    expect(moveBulletTo(editor, 'today', 'ordinary', 'after')).toBe(false)
    expect(trashBullet(editor, 'inbox')).toBeNull()
    expect(duplicateBullet(editor, 'today')).toBe(false)
    expect(setBulletKind(editor, 'daily', 'todo')).toBe(false)
    expect(toggleBulletCompleted(editor, 'today')).toBe(false)
    expect(collectBullets(editor.state.doc).filter((entry) => entry.systemRole === 'inbox')).toHaveLength(1)
  })

  it('moves a daily-note root and its descendants to Trash with system metadata intact', () => {
    editor.commands.setContent({
      type: 'doc',
      content: [{
        type: 'bulletList',
        content: [
          systemItem('inbox', 'Inbox', 'inbox'),
          systemItem('daily', 'Daily Notes', 'daily-notes', [
            systemItem('today', 'Today', 'daily-note', [item('journal', 'Journal')]),
          ]),
        ],
      }],
    })

    const deleted = trashBullet(editor, 'today')

    expect(deleted).not.toBeNull()
    expect(deleted?.originalParentId).toBe('daily')
    expect(deleted?.node).toMatchObject({
      attrs: {
        nodeId: 'today',
        systemRole: 'daily-note',
        dailyDate: '2026-08-30',
      },
      content: expect.arrayContaining([
        expect.objectContaining({
          type: 'bulletList',
          content: expect.arrayContaining([
            expect.objectContaining({ attrs: expect.objectContaining({ nodeId: 'journal' }) }),
          ]),
        }),
      ]),
    })
    expect(collectBullets(editor.state.doc).map((entry) => entry.id)).toEqual(['inbox', 'daily'])
  })

  it('restores a trashed daily note with its metadata, descendants, parent, and sibling position', () => {
    editor.commands.setContent({
      type: 'doc',
      content: [{
        type: 'bulletList',
        content: [
          systemItem('inbox', 'Inbox', 'inbox'),
          systemItem('daily', 'Daily Notes', 'daily-notes', [
            item('pinned-before', 'Pinned before'),
            systemItem('today', 'Today', 'daily-note', [item('journal', 'Journal')]),
            item('pinned-after', 'Pinned after'),
          ]),
        ],
      }],
    })

    const deleted = trashBullet(editor, 'today')

    expect(deleted && restoreBullet(editor, deleted)).toBe(true)
    const restored = collectBullets(editor.state.doc).find((entry) => entry.id === 'today')
    expect(restored).toMatchObject({
      systemRole: 'daily-note',
      dailyDate: '2026-08-30',
      ancestorIds: ['daily'],
    })
    expect(collectBullets(editor.state.doc).find((entry) => entry.id === 'journal')?.ancestorIds)
      .toEqual(['daily', 'today'])
    expect(collectBullets(editor.state.doc)
      .filter((entry) => entry.ancestorIds.length === 1 && entry.ancestorIds[0] === 'daily')
      .map((entry) => entry.id))
      .toEqual(['pinned-before', 'today', 'pinned-after'])
  })

  it('does not restore a daily note when its valid date is already live under a different ID', () => {
    editor.commands.setContent({
      type: 'doc',
      content: [{
        type: 'bulletList',
        content: [
          systemItem('inbox', 'Inbox', 'inbox'),
          systemItem('daily', 'Daily Notes', 'daily-notes', [
            systemItem('today', 'Today', 'daily-note', [item('journal', 'Journal')]),
          ]),
        ],
      }],
    })
    const deleted = trashBullet(editor, 'today')!
    const ids = ['replacement', 'replacement-entry']
    expect(openOrCreateDailyNote(editor, {
      date: '2026-08-30',
      locale: 'en-US',
      nextId: () => ids.shift()!,
    })).toMatchObject({ id: 'replacement', created: true })
    const beforeRestore = editor.getJSON()

    expect(restoreBullet(editor, deleted)).toBe(false)
    expect(editor.getJSON()).toEqual(beforeRestore)
    expect(collectBullets(editor.state.doc).filter((entry) => (
      entry.systemRole === 'daily-note' && entry.dailyDate === '2026-08-30'
    ))).toHaveLength(1)
  })

  it.each([
    ['missing', null],
    ['impossible', '2026-02-30'],
    ['noncanonical', '2026-8-30'],
  ])('does not restore a daily note with %s daily-date metadata', (_label, dailyDate) => {
    editor.commands.setContent({
      type: 'doc',
      content: [{
        type: 'bulletList',
        content: [
          systemItem('inbox', 'Inbox', 'inbox'),
          systemItem('daily', 'Daily Notes', 'daily-notes', [
            systemItem('today', 'Today', 'daily-note', [item('journal', 'Journal')], dailyDate),
          ]),
        ],
      }],
    })
    const deleted = trashBullet(editor, 'today')!
    const beforeRestore = editor.getJSON()

    expect(restoreBullet(editor, deleted)).toBe(false)
    expect(editor.getJSON()).toEqual(beforeRestore)
  })

  it.each([
    ['stale', 'retired-daily-notes', 99, ['pinned-before', 'pinned-after', 'today']],
    ['wrong', 'ordinary', -10, ['today', 'pinned-before', 'pinned-after']],
    ['missing', null, 1, ['pinned-before', 'today', 'pinned-after']],
  ])('restores a daily note under the canonical container when its saved parent is %s', (
    _label,
    parentId,
    originalIndex,
    expectedOrder,
  ) => {
    editor.commands.setContent({
      type: 'doc',
      content: [{
        type: 'bulletList',
        content: [
          systemItem('inbox', 'Inbox', 'inbox'),
          systemItem('daily-current', 'Daily Notes', 'daily-notes', [
            item('pinned-before', 'Pinned before'),
            systemItem('today', 'Today', 'daily-note', [item('journal', 'Journal')]),
            item('pinned-after', 'Pinned after'),
          ]),
          item('ordinary', 'Ordinary'),
        ],
      }],
    })
    const deleted = trashBullet(editor, 'today')!
    deleted.originalParentId = parentId
    deleted.originalIndex = originalIndex

    expect(restoreBullet(editor, deleted)).toBe(true)
    expect(collectBullets(editor.state.doc).find((entry) => entry.id === 'today')?.ancestorIds)
      .toEqual(['daily-current'])
    expect(collectBullets(editor.state.doc)
      .filter((entry) => entry.ancestorIds.length === 1 && entry.ancestorIds[0] === 'daily-current')
      .map((entry) => entry.id))
      .toEqual(expectedOrder)
    expect(collectBullets(editor.state.doc).find((entry) => entry.id === 'ordinary')?.ancestorIds)
      .toEqual([])
  })

  it('does not restore a daily note when the canonical daily-notes container is absent', () => {
    editor.commands.setContent({
      type: 'doc',
      content: [{
        type: 'bulletList',
        content: [
          systemItem('today', 'Today', 'daily-note', [item('journal', 'Journal')]),
          item('ordinary', 'Ordinary'),
        ],
      }],
    })
    const deleted = trashBullet(editor, 'today')!
    const beforeRestore = editor.getJSON()

    expect(restoreBullet(editor, deleted)).toBe(false)
    expect(editor.getJSON()).toEqual(beforeRestore)
  })

  it('silently rejects direct title edits and deletion while keeping the title selectable', () => {
    editor.commands.setContent({
      type: 'doc',
      content: [{
        type: 'bulletList',
        content: [
          systemItem('inbox', 'Inbox', 'inbox', [item('capture', 'Captured')]),
          systemItem('daily', 'Daily Notes', 'daily-notes'),
          item('ordinary', 'Ordinary'),
        ],
      }],
    })

    const inbox = collectBullets(editor.state.doc).find((entry) => entry.id === 'inbox')!
    const rejected = vi.fn()
    window.addEventListener('forage-system-node-rejected', rejected, { once: true })
    const title = editor.view.dom.querySelector('[data-system-role="inbox"] > p')
    expect(title?.getAttribute('contenteditable')).toBeNull()
    expect(title?.getAttribute('aria-readonly')).toBe('true')
    editor.commands.setTextSelection(inbox.pos + 3)
    editor.commands.insertContent('renamed ')
    expect(collectBullets(editor.state.doc).find((entry) => entry.id === 'inbox')?.text).toBe('Inbox')

    const currentInbox = collectBullets(editor.state.doc).find((entry) => entry.id === 'inbox')!
    editor.view.dispatch(editor.state.tr.delete(currentInbox.pos, currentInbox.pos + currentInbox.node.nodeSize))
    expect(collectBullets(editor.state.doc).find((entry) => entry.id === 'inbox')?.text).toBe('Inbox')
    expect(rejected).not.toHaveBeenCalled()
    window.removeEventListener('forage-system-node-rejected', rejected)
  })

  it('renders the bullet for a new Inbox child immediately after deleting the empty child', () => {
    editor.commands.setContent({
      type: 'doc',
      content: [{
        type: 'bulletList',
        content: [
          systemItem('inbox', 'Inbox', 'inbox', [item('capture', 'Captured')]),
          systemItem('daily', 'Daily Notes', 'daily-notes'),
        ],
      }],
    })

    setZoom(editor, 'inbox')
    expect(updateBulletText(editor, 'capture', '')).toBe(true)
    const capture = collectBullets(editor.state.doc).find((entry) => entry.id === 'capture')!
    editor.commands.setTextSelection(capture.pos + 2)
    editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Backspace', bubbles: true, cancelable: true,
    }))
    expect(collectBullets(editor.state.doc).some((entry) => entry.id === 'capture')).toBe(false)
    expect(currentBulletId(editor)).toBe('inbox')
    editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true, cancelable: true,
    }))

    const children = collectBullets(editor.state.doc).filter((entry) => (
      entry.ancestorIds.length === 1 && entry.ancestorIds[0] === 'inbox'
    ))
    expect(children).toHaveLength(1)
    expect(children[0].text).toBe('')
    expect(currentBulletId(editor)).toBe(children[0].id)
    const childId = children[0].id
    const beforeSecondEnter = editor.getJSON()

    editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true, cancelable: true,
    }))

    const childrenAfterSecondEnter = collectBullets(editor.state.doc).filter((entry) => (
      entry.ancestorIds.length === 1 && entry.ancestorIds[0] === 'inbox'
    ))
    const childRow = editor.view.dom.querySelector(`[data-node-id="${childId}"]`)
    expect(editor.getJSON()).toEqual(beforeSecondEnter)
    expect(currentBulletId(editor)).toBe(childId)
    expect(childrenAfterSecondEnter).toHaveLength(1)
    expect(childRow?.querySelector(':scope > .bullet-controls .bullet-dot')).toBeTruthy()
    expect(childRow?.classList.contains('zoom-hidden')).toBe(false)
  })

  it('preserves a generated image beside an empty Inbox child removed with Backspace', () => {
    const assetId = 'a'.repeat(64)
    editor.commands.setContent({
      type: 'doc',
      content: [{
        type: 'bulletList',
        content: [
          systemItem('inbox', 'Inbox', 'inbox', [
            item('capture', 'Captured'),
            {
              type: 'generatedImageItem',
              content: [{
                type: 'generatedImage',
                attrs: { assetId, alt: 'Keep this image' },
              }],
            },
          ]),
          systemItem('daily', 'Daily Notes', 'daily-notes'),
        ],
      }],
    })

    expect(updateBulletText(editor, 'capture', '')).toBe(true)
    const capture = collectBullets(editor.state.doc).find((entry) => entry.id === 'capture')!
    editor.commands.setTextSelection(capture.pos + 2)
    editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Backspace', bubbles: true, cancelable: true,
    }))

    const inbox = collectBullets(editor.state.doc).find((entry) => entry.id === 'inbox')!
    const childList = Array.from({ length: inbox.node.childCount }, (_, index) => inbox.node.child(index))
      .find((node) => node.type === editor.schema.nodes.bulletList)
    expect(collectBullets(editor.state.doc).some((entry) => entry.id === 'capture')).toBe(false)
    expect(currentBulletId(editor)).toBe('inbox')
    expect(childList?.childCount).toBe(1)
    expect(childList?.firstChild?.type.name).toBe('generatedImageItem')
    expect(childList?.firstChild?.firstChild?.attrs).toMatchObject({ assetId, alt: 'Keep this image' })
  })

  it('accepts an explicitly trusted remote projection that updates a protected label', () => {
    editor.commands.setContent({
      type: 'doc',
      content: [{ type: 'bulletList', content: [
        systemItem('inbox', 'Inbox', 'inbox'),
        systemItem('daily', 'Daily Notes', 'daily-notes'),
      ] }],
    })
    const replacement = editor.schema.nodeFromJSON({
      type: 'doc',
      content: [{ type: 'bulletList', content: [
        systemItem('inbox', 'Inbox', 'inbox'),
        systemItem('daily', 'Notes quotidiennes', 'daily-notes'),
      ] }],
    })
    const transaction = editor.state.tr
      .replaceWith(0, editor.state.doc.content.size, replacement.content)
      .setMeta('forageRemote', true)
    editor.view.dispatch(transaction)

    expect(collectBullets(editor.state.doc).find((entry) => entry.id === 'daily')?.text)
      .toBe('Notes quotidiennes')
  })

  it('blocks local document transactions while synchronization applies a trusted projection', () => {
    const before = editor.state.doc
    setEditorMutationLocked(editor, true)
    try {
      editor.view.dispatch(editor.state.tr.insertText('blocked', 3))
      expect(editor.state.doc.eq(before)).toBe(true)

      editor.view.dispatch(editor.state.tr.insertText('remote', 3).setMeta('forageRemote', true))
      expect(editor.state.doc.textContent).toContain('remote')
    } finally {
      setEditorMutationLocked(editor, false)
    }
  })

  it('allows direct edits beneath protected system roots', () => {
    editor.commands.setContent({
      type: 'doc',
      content: [{
        type: 'bulletList',
        content: [
          systemItem('inbox', 'Inbox', 'inbox', [item('capture', 'Captured')]),
          systemItem('daily', 'Daily Notes', 'daily-notes'),
        ],
      }],
    })

    const capture = collectBullets(editor.state.doc).find((entry) => entry.id === 'capture')!
    editor.commands.setTextSelection(capture.pos + 2 + capture.text.length)
    editor.commands.insertContent(' note')

    expect(collectBullets(editor.state.doc).find((entry) => entry.id === 'capture')?.text).toBe('Captured note')
  })

  it('keeps ordinary descendants fully movable, trashable, and convertible', () => {
    editor.commands.setContent({
      type: 'doc',
      content: [{
        type: 'bulletList',
        content: [
          systemItem('inbox', 'Inbox', 'inbox', [item('capture', 'Captured')]),
          systemItem('daily', 'Daily Notes', 'daily-notes'),
          item('ordinary', 'Ordinary'),
        ],
      }],
    })

    expect(setBulletKind(editor, 'capture', 'todo')).toBe(true)
    expect(moveBulletTo(editor, 'capture', 'ordinary', 'inside')).toBe(true)
    expect(collectBullets(editor.state.doc).find((entry) => entry.id === 'capture')?.ancestorIds).toEqual(['ordinary'])
    expect(trashBullet(editor, 'capture')).not.toBeNull()
  })

  it('makes protected keyboard indent, outdent, and full-document replacement no-ops', () => {
    editor.commands.setContent({
      type: 'doc',
      content: [{
        type: 'bulletList',
        content: [
          systemItem('inbox', 'Inbox', 'inbox'),
          systemItem('daily', 'Daily Notes', 'daily-notes', [
            systemItem('today', 'Today', 'daily-note'),
          ]),
          item('ordinary', 'Ordinary'),
        ],
      }],
    })
    const before = editor.getJSON()
    const inbox = collectBullets(editor.state.doc).find((entry) => entry.id === 'inbox')!
    editor.commands.setTextSelection(inbox.pos + 2)
    editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    const today = collectBullets(editor.state.doc).find((entry) => entry.id === 'today')!
    editor.commands.setTextSelection(today.pos + 2)
    editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }))
    editor.commands.selectAll()
    editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }))

    expect(editor.getJSON()).toEqual(before)
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

  it('preserves hard breaks in note text used by search and context', () => {
    expect(focusOrCreateBulletNote(editor, 'bravo')).toBe(true)
    expect(editor.commands.insertContent('First')).toBe(true)
    expect(editor.commands.insertContent({ type: 'hardBreak' })).toBe(true)
    expect(editor.commands.insertContent('Second')).toBe(true)

    expect(collectBullets(editor.state.doc).find((entry) => entry.id === 'bravo')?.noteText)
      .toBe('First\nSecond')
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
