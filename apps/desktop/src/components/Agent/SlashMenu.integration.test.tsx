import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { BulletAttributes } from '../../editor/extensions'
import { NativeEventRepository } from '../../persistence/eventStore'
import { SlashMenu } from './SlashMenu'

describe('slash menu while running a skill', () => {
  let editor: Editor

  afterEach(() => {
    cleanup()
    editor?.destroy()
    vi.restoreAllMocks()
  })

  it.each([false, true])('stays closed through editor updates after running (completed first: %s)', (completeFirst) => {
    // Hold admission open to reproduce updates while the slash prefix remains.
    const storageMode = vi.spyOn(NativeEventRepository.prototype, 'storageMode')
      .mockImplementation(() => new Promise(() => {}))
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [StarterKit.configure({ trailingNode: false }), BulletAttributes],
      content: '<ul><li><p>/ask question</p></li><li><p>Other bullet</p></li></ul>',
    })
    render(<SlashMenu editor={editor} onError={vi.fn()} />)
    act(() => { editor.commands.setTextSelection(5) })
    expect(screen.getByText('/ask')).toBeTruthy()
    if (completeFirst) {
      fireEvent.keyDown(window, { key: 'Tab' })
      expect(screen.queryByText('/ask')).toBeNull()
    }
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(storageMode).toHaveBeenCalledOnce()
    expect(screen.queryByText('/ask')).toBeNull()

    act(() => {
      const last = editor.state.doc.content.size - 3
      editor.view.dispatch(editor.state.tr.insertText(' updated', last))
    })
    act(() => { editor.commands.setTextSelection(4) })
    expect(screen.queryByText('/ask')).toBeNull()

    // Editing the invocation itself starts a fresh interaction.
    act(() => { editor.view.dispatch(editor.state.tr.insertText('new ', 8)) })
    expect(screen.getByText('/ask')).toBeTruthy()
  })
})
