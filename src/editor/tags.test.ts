import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import {
  activeTagAtSelection,
  collectTags,
  OUTLINE_TAG_EVENT,
  TagDecorations,
  tagsInText,
} from './tags'

function makeEditor(text: string): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit, TagDecorations],
    content: `<p>${text}</p>`,
  })
}

describe('outline tags', () => {
  let editor: Editor

  beforeEach(() => {
    editor = makeEditor('Plan #Research and #product-roadmap')
  })

  afterEach(() => editor.destroy())

  it('extracts unique, case-insensitive tags without treating URL fragments as tags', () => {
    expect(tagsInText('Use #Research and #research, not https://example.com/#anchor or C#')).toEqual([
      'research',
      'research',
    ])
    expect(collectTags(editor.state.doc)).toEqual(['product-roadmap', 'research'])
  })

  it('decorates hashtags without replacing their plain document text', () => {
    const tags = [...editor.view.dom.querySelectorAll<HTMLElement>('.outline-tag')]

    expect(tags.map((tag) => tag.dataset.tag)).toEqual(['research', 'product-roadmap'])
    expect(editor.state.doc.textContent).toBe('Plan #Research and #product-roadmap')
  })

  it('reports the active hashtag range for autocomplete', () => {
    editor.destroy()
    editor = makeEditor('Plan #res')
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)

    const active = activeTagAtSelection(editor.state)

    expect(active?.query).toBe('res')
    expect(editor.state.doc.textBetween(active!.from, active!.to)).toBe('#res')
  })

  it('emits a search event when a decorated tag is clicked', () => {
    const listener = vi.fn()
    window.addEventListener(OUTLINE_TAG_EVENT, listener, { once: true })

    editor.view.dom.querySelector<HTMLElement>('.outline-tag')?.click()

    expect(listener).toHaveBeenCalledOnce()
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual({ tag: 'research' })
  })
})
