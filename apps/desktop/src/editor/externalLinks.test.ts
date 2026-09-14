import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { BulletAttributes } from './extensions'
import { InternalLink } from './internalLinks'
import { ExternalLink, OUTLINE_LINK_PEEK_EVENT } from './externalLinks'

const openUrl = vi.fn()
vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: (href: string) => { openUrl(href); return Promise.resolve() },
}))

interface MarkJson { type: string; attrs: Record<string, unknown> }

function linked(text: string, mark: MarkJson) {
  return {
    type: 'listItem',
    attrs: { nodeId: 'alpha' },
    content: [{ type: 'paragraph', content: [{ type: 'text', text, marks: [mark] }] }],
  }
}

function makeEditor(mark: MarkJson): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: [
      StarterKit.configure({ trailingNode: false, link: { openOnClick: false } }),
      BulletAttributes,
      InternalLink,
      ExternalLink,
    ],
    content: {
      type: 'doc',
      content: [{ type: 'bulletList', content: [linked('Example', mark)] }],
    },
  })
}

function clickAnchor(editor: Editor, selector: string, init: MouseEventInit = {}) {
  const anchor = editor.view.dom.querySelector<HTMLAnchorElement>(selector)
  expect(anchor).not.toBeNull()
  anchor?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ...init }))
}

describe('external link clicks', () => {
  const editors: Editor[] = []
  const peeks: string[] = []
  const onPeek = (event: Event) => {
    peeks.push((event as CustomEvent<{ href: string }>).detail.href)
  }

  beforeEach(() => {
    window.addEventListener(OUTLINE_LINK_PEEK_EVENT, onPeek)
  })

  afterEach(() => {
    window.removeEventListener(OUTLINE_LINK_PEEK_EVENT, onPeek)
    peeks.length = 0
    openUrl.mockClear()
    editors.splice(0).forEach((editor) => editor.destroy())
  })

  function editorWith(mark: MarkJson): Editor {
    const editor = makeEditor(mark)
    editors.push(editor)
    return editor
  }

  it('asks for an in-app peek instead of opening a browser', () => {
    const editor = editorWith({ type: 'link', attrs: { href: 'https://example.com/docs' } })
    clickAnchor(editor, 'a[href]')
    expect(peeks).toEqual(['https://example.com/docs'])
    expect(openUrl).not.toHaveBeenCalled()
  })

  it('escapes to the real browser on a modifier click', () => {
    const editor = editorWith({ type: 'link', attrs: { href: 'https://example.com/docs' } })
    clickAnchor(editor, 'a[href]', { metaKey: true })
    expect(peeks).toEqual([])
    expect(openUrl).toHaveBeenCalledWith('https://example.com/docs')
  })

  it('sends mailto links straight to the system handler', () => {
    const editor = editorWith({ type: 'link', attrs: { href: 'mailto:hi@example.com' } })
    clickAnchor(editor, 'a[href]')
    expect(peeks).toEqual([])
    expect(openUrl).toHaveBeenCalledWith('mailto:hi@example.com')
  })

  it('leaves internal outline links to their own handler', () => {
    const editor = editorWith({ type: 'internalLink', attrs: { targetId: 'beta' } })
    clickAnchor(editor, 'a[data-internal-node-id]')
    expect(peeks).toEqual([])
    expect(openUrl).not.toHaveBeenCalled()
  })
})
