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

function pressBackspace(editor: Editor): boolean {
  const event = new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })
  editor.view.dom.dispatchEvent(event)
  return event.defaultPrevented
}

function typeText(editor: Editor, text: string): void {
  for (const character of text) editor.view.dispatch(editor.state.tr.insertText(character))
}

function caretAfter(editor: Editor, text: string): void {
  editor.commands.setTextSelection(editor.state.doc.textContent.indexOf(text) + text.length + 1)
}

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

  it('deletes a whole existing tag with Backspace, as one undo step', () => {
    caretAfter(editor, '#Research')

    expect(pressBackspace(editor)).toBe(true)
    expect(editor.state.doc.textContent).toBe('Plan and #product-roadmap')
    expect(editor.state.selection.from).toBe('Plan'.length + 1)

    editor.commands.undo()
    expect(editor.state.doc.textContent).toBe('Plan #Research and #product-roadmap')
  })

  it('deletes a whole tag when the caret sits inside it', () => {
    caretAfter(editor, '#product-road')

    expect(pressBackspace(editor)).toBe(true)
    expect(editor.state.doc.textContent).toBe('Plan #Research and ')
  })

  it('edits a tag one character at a time while it is being typed', () => {
    editor.destroy()
    editor = makeEditor('Plan')
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)
    typeText(editor, ' #resx')

    expect(pressBackspace(editor)).toBe(false)
    expect(editor.state.doc.textContent).toBe('Plan #resx')
  })

  it('treats a typed tag as whole once the caret leaves it', () => {
    editor.destroy()
    editor = makeEditor('Plan')
    editor.commands.setTextSelection(editor.state.doc.content.size - 1)
    typeText(editor, ' #research ')
    const { from } = editor.state.selection
    editor.view.dispatch(editor.state.tr.delete(from - 1, from))

    expect(pressBackspace(editor)).toBe(true)
    expect(editor.state.doc.textContent).toBe('Plan ')
  })

  it('leaves Backspace alone outside tags', () => {
    caretAfter(editor, 'Plan')

    expect(pressBackspace(editor)).toBe(false)
  })
})
