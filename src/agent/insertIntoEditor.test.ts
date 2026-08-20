// Tests for the bridge between the Codex stream and the TipTap document.
//
// Two behaviours matter and both were broken:
//   - agent output arrives as one idea per line and must become one bullet per
//     line (a single text node collapses the newlines in HTML)
//   - starting a generation must not steal the caret from the user

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { BulletAttributes, OutlinerKeymap } from '../editor/extensions'
import { BulletNote } from '../editor/bulletNote'
import {
  insertAiChild,
  setCurrentBulletText,
  siblingContext,
  writeAiText,
} from './insertIntoEditor'

function makeEditor(text: string): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit, BulletAttributes, BulletNote, OutlinerKeymap],
    content: {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              attrs: { nodeType: 'user' },
              content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
            },
          ],
        },
      ],
    },
  })
}

/** Text of every listItem in the document, in document order. */
function bulletTexts(editor: Editor): string[] {
  const out: string[] = []
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'listItem') out.push(node.firstChild?.textContent ?? '')
  })
  return out
}

describe('agent output insertion', () => {
  let editor: Editor

  beforeEach(() => {
    editor = makeEditor('Research topic')
    // Put the caret inside the user bullet's text.
    editor.commands.setTextSelection(3)
  })

  afterEach(() => {
    editor.destroy()
  })

  it('can complete a slash command and place the caret after it', () => {
    setCurrentBulletText(editor, '/research ', true)

    expect(bulletTexts(editor)).toEqual(['/research '])
    expect(editor.state.selection.$from.parentOffset).toBe('/research '.length)
  })

  it('collects direct sibling text in document order', () => {
    editor.commands.setContent({
      type: 'doc',
      content: [{
        type: 'bulletList',
        content: ['Previous note', 'Current task', 'Following note'].map((text, index) => ({
          type: 'listItem',
          content: [
            { type: 'paragraph', content: [{ type: 'text', text }] },
            ...(index === 0 ? [{
              type: 'bulletNote',
              content: [{ type: 'text', text: 'Previous detail' }],
            }] : []),
          ],
        })),
      }],
    })
    let currentPos = -1
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'listItem' && node.firstChild?.textContent === 'Current task') {
        currentPos = pos + 2
        return false
      }
      return undefined
    })
    editor.commands.setTextSelection(currentPos)

    expect(siblingContext(editor)).toEqual([
      'Previous note\nNote: Previous detail',
      'Following note',
    ])
  })

  it('leaves the caret in the trigger bullet when the AI child is inserted', () => {
    const before = editor.state.selection.from

    insertAiChild(editor)

    expect(editor.state.selection.from).toBe(before)
  })

  it('writes each line of agent output into its own bullet', () => {
    const nodeId = insertAiChild(editor)!

    writeAiText(editor, nodeId, 'First finding\nSecond finding\nThird finding')

    expect(bulletTexts(editor)).toEqual([
      'Research topic',
      'First finding',
      'Second finding',
      'Third finding',
    ])
  })

  it('drops blank separator lines instead of rendering empty AI bullets', () => {
    const nodeId = insertAiChild(editor)!

    writeAiText(editor, nodeId, 'First finding\n\n  \nSecond finding\n')

    expect(bulletTexts(editor)).toEqual([
      'Research topic',
      'First finding',
      'Second finding',
    ])
  })

  it('grows the bullet list as more lines stream in', () => {
    const nodeId = insertAiChild(editor)!

    writeAiText(editor, nodeId, 'First find')
    writeAiText(editor, nodeId, 'First finding\nSecond fin')
    writeAiText(editor, nodeId, 'First finding\nSecond finding')

    expect(bulletTexts(editor)).toEqual([
      'Research topic',
      'First finding',
      'Second finding',
    ])
  })

  it('marks every generated bullet as AI-written', () => {
    const nodeId = insertAiChild(editor)!

    writeAiText(editor, nodeId, 'One\nTwo')

    const types: string[] = []
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'listItem') types.push(node.attrs.nodeType)
    })
    expect(types).toEqual(['user', 'ai', 'ai'])
  })

  it('keeps the whole generation out of the undo history', () => {
    const nodeId = insertAiChild(editor)!
    writeAiText(editor, nodeId, 'One\nTwo\nThree')

    editor.commands.undo()

    // A single undo removes the entire generation, leaving the original bullet.
    expect(bulletTexts(editor)).toEqual(['Research topic'])
  })

  it('does not move the caret while text streams in', () => {
    const nodeId = insertAiChild(editor)!
    const before = editor.state.selection.from

    writeAiText(editor, nodeId, 'First finding\nSecond finding')

    expect(editor.state.selection.from).toBe(before)
  })
})
