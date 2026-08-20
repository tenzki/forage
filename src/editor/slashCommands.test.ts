import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { SlashCommandDecorations } from './slashCommands'

function editorWithText(text: string): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit, SlashCommandDecorations],
    content: `<p>${text}</p>`,
  })
}

describe('slash command styling', () => {
  let editor: Editor | null = null

  afterEach(() => editor?.destroy())

  it('styles a recognized command without changing its text', () => {
    editor = editorWithText('/research Workflowy competitors')

    const command = editor.view.dom.querySelector<HTMLElement>('.outline-command')
    expect(command?.textContent).toBe('/research')
    expect(command?.dataset.command).toBe('research')
    expect(editor.state.doc.textContent).toBe('/research Workflowy competitors')
  })

  it('styles a local outline command without changing its text', () => {
    editor = editorWithText('/todo Buy milk')

    const command = editor.view.dom.querySelector<HTMLElement>('.outline-command')
    expect(command?.textContent).toBe('/todo')
    expect(command?.dataset.command).toBe('todo')
    expect(editor.state.doc.textContent).toBe('/todo Buy milk')
  })

  it('does not style unknown slash text', () => {
    editor = editorWithText('/unknown Keep this as plain text')

    expect(editor.view.dom.querySelector('.outline-command')).toBeNull()
  })
})
