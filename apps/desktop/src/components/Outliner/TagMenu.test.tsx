import { afterEach, describe, expect, it } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { TextSelection } from '@tiptap/pm/state'
import { BulletAttributes } from '../../editor/extensions'
import { TagMenu } from './TagMenu'

function makeEditor(): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit.configure({ trailingNode: false }), BulletAttributes],
    content: {
      type: 'doc',
      content: [{
        type: 'bulletList',
        content: [{
          type: 'listItem',
          attrs: { nodeId: 'parent' },
          content: [
            { type: 'paragraph', content: [{ type: 'text', text: 'Parent #work' }] },
            {
              type: 'bulletList',
              content: [{
                type: 'listItem',
                attrs: { nodeId: 'child' },
                content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Child' }] }],
              }],
            },
          ],
        }],
      }],
    },
  })
}

function endOfParentTitle(editor: Editor): number {
  let end = 0
  editor.state.doc.descendants((node, pos) => {
    if (!end && node.type.name === 'paragraph') end = pos + 1 + node.content.size
  })
  return end
}

describe('tag menu', () => {
  let editor: Editor | null = null

  afterEach(() => {
    editor?.view.dom.remove()
    editor?.destroy()
    editor = null
  })

  it('stays closed when the caret only rests after an existing tag', () => {
    editor = makeEditor()
    document.body.appendChild(editor.view.dom)
    render(<TagMenu editor={editor as never} />)

    act(() => {
      editor!.view.dispatch(editor!.state.tr.setSelection(
        TextSelection.create(editor!.state.doc, endOfParentTitle(editor!)),
      ))
    })

    expect(screen.queryByRole('list', { name: 'Tag suggestions' })).toBeNull()
    const arrowDown = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })
    window.dispatchEvent(arrowDown)
    expect(arrowDown.defaultPrevented).toBe(false)
  })

  it('opens while a tag is being typed', () => {
    editor = makeEditor()
    document.body.appendChild(editor.view.dom)
    render(<TagMenu editor={editor as never} />)

    act(() => {
      editor!.view.dispatch(editor!.state.tr.setSelection(
        TextSelection.create(editor!.state.doc, endOfParentTitle(editor!)),
      ))
      editor!.view.dispatch(editor!.state.tr.insertText(' #w'))
    })

    expect(screen.getByRole('list', { name: 'Tag suggestions' })).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('list', { name: 'Tag suggestions' })).toBeNull()
  })
})
