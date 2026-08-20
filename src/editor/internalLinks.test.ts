import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { BulletAttributes } from './extensions'
import {
  activeInternalLinkAtSelection,
  collectBacklinks,
  createAndInsertInternalLink,
  insertInternalLink,
  InternalLink,
  OUTLINE_INTERNAL_LINK_EVENT,
} from './internalLinks'
import { collectBullets } from './outlineModel'

function item(id: string, text: string, targetId?: string) {
  return {
    type: 'listItem',
    attrs: { nodeId: id },
    content: [{
      type: 'paragraph',
      content: [{
        type: 'text',
        text,
        ...(targetId ? { marks: [{ type: 'internalLink', attrs: { targetId } }] } : {}),
      }],
    }],
  }
}

function makeEditor(includeTarget = true): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit, BulletAttributes, InternalLink],
    content: {
      type: 'doc',
      content: [{
        type: 'bulletList',
        content: [item('alpha', 'Alpha'), ...(includeTarget ? [item('beta', 'Beta')] : [])],
      }],
    },
  })
}

describe('internal outline links', () => {
  const editors: Editor[] = []

  afterEach(() => {
    editors.splice(0).forEach((editor) => editor.destroy())
  })

  it('replaces a [[ query with a stable-id link and reports its backlink', () => {
    const editor = makeEditor()
    editors.push(editor)
    const alpha = collectBullets(editor.state.doc)[0]
    editor.chain().setTextSelection(alpha.pos + 2 + alpha.text.length).insertContent(' [[Be').run()
    const active = activeInternalLinkAtSelection(editor.state)

    expect(active?.query).toBe('Be')
    expect(insertInternalLink(editor, active!, 'beta', 'Beta')).toBe(true)
    const linkedText = editor.state.doc.nodeAt(alpha.pos + 2 + 'Alpha '.length)
    expect(linkedText?.marks[0]?.attrs.targetId).toBe('beta')
    expect(collectBacklinks(editor.state.doc, 'beta').map(({ source }) => source.id)).toEqual(['alpha'])

    const listener = vi.fn()
    window.addEventListener(OUTLINE_INTERNAL_LINK_EVENT, listener)
    editor.view.dom.querySelector('a[data-internal-node-id="beta"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect((listener.mock.calls[0][0] as CustomEvent).detail.targetId).toBe('beta')
    window.removeEventListener(OUTLINE_INTERNAL_LINK_EVENT, listener)
  })

  it('can create a root item while inserting a link to its new stable id', () => {
    const editor = makeEditor(false)
    editors.push(editor)
    const alpha = collectBullets(editor.state.doc)[0]
    editor.chain().setTextSelection(alpha.pos + 2 + alpha.text.length).insertContent(' [[New topic').run()
    const active = activeInternalLinkAtSelection(editor.state)!
    const targetId = createAndInsertInternalLink(editor, active, 'New topic')
    const entries = collectBullets(editor.state.doc)

    expect(targetId).toBeTruthy()
    expect(entries.map((entry) => entry.text)).toEqual(['Alpha New topic ', 'New topic'])
    expect(collectBacklinks(editor.state.doc, targetId!)[0]?.source.id).toBe('alpha')
  })

  it('marks missing targets as broken and prevents dead navigation', () => {
    const editor = new Editor({
      element: document.createElement('div'),
      extensions: [StarterKit, BulletAttributes, InternalLink],
      content: {
        type: 'doc',
        content: [{ type: 'bulletList', content: [item('alpha', 'Missing', 'deleted')] }],
      },
    })
    editors.push(editor)
    const listener = vi.fn()
    window.addEventListener(OUTLINE_INTERNAL_LINK_EVENT, listener)
    const anchor = editor.view.dom.querySelector<HTMLAnchorElement>('a[data-internal-node-id="deleted"]')

    expect(editor.view.dom.querySelector('.internal-link-broken')).toBeTruthy()
    anchor?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(listener).not.toHaveBeenCalled()
    window.removeEventListener(OUTLINE_INTERNAL_LINK_EVENT, listener)
  })
})
