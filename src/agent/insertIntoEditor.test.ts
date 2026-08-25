// Tests for the bridge between the Codex stream and the TipTap document.
//
// Two behaviours matter and both were broken:
//   - agent output arrives as one idea per line and must become one bullet per
//     line (a single text node collapses the newlines in HTML)
//   - starting a generation must not steal the caret from the user

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { BulletAttributes, OutlinerKeymap } from '../editor/extensions'
import { BulletNote } from '../editor/bulletNote'
import { InternalLink } from '../editor/internalLinks'
import {
  GeneratedImage,
  GeneratedImageItem,
  OutlineBulletList,
} from '../editor/generatedImage'
import { generateWithPi } from './piGeneration'
import {
  insertAiChild,
  removeCurrentSlashCommand,
  runSkillIntoEditor,
  skillActivityLabel,
  setCurrentBulletText,
  siblingContext,
  writeAiOutline,
  writeAiText,
} from './insertIntoEditor'

vi.mock('./piGeneration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./piGeneration')>()
  return { ...actual, generateWithPi: vi.fn() }
})

function makeEditor(text: string): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: [
      StarterKit.configure({ bulletList: false, trailingNode: false }),
      OutlineBulletList,
      GeneratedImageItem,
      GeneratedImage,
      BulletAttributes,
      BulletNote,
      InternalLink,
      OutlinerKeymap,
    ],
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
  it('includes the prompt in the activity call label', () => {
    expect(skillActivityLabel('research', 'Compare Tauri and Electron')).toBe('Run /research Compare Tauri and Electron')
    expect(skillActivityLabel('research', '   ')).toBe('Run /research')
  })

  let editor: Editor

  beforeEach(() => {
    vi.mocked(generateWithPi).mockReset()
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

  it('removes the command prefix without discarding a structured reference', () => {
    editor.commands.setContent({
      type: 'doc',
      content: [{
        type: 'bulletList',
        content: [{
          type: 'listItem',
          attrs: { nodeId: 'command' },
          content: [{
            type: 'paragraph',
            content: [
              { type: 'text', text: '/ask ' },
              { type: 'text', text: 'Linked topic', marks: [{ type: 'internalLink', attrs: { targetId: 'topic' } }] },
            ],
          }],
        }, {
          type: 'listItem',
          attrs: { nodeId: 'topic' },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Topic' }] }],
        }],
      }],
    })
    editor.commands.setTextSelection(3)

    removeCurrentSlashCommand(editor, 'ask')

    const paragraph = editor.state.doc.firstChild?.firstChild?.firstChild
    expect(paragraph?.textContent).toBe('Linked topic')
    expect(paragraph?.firstChild?.marks[0]?.attrs.targetId).toBe('topic')
  })

  it('does not insert a placeholder when context preflight fails', () => {
    editor.commands.setContent({
      type: 'doc',
      content: [{
        type: 'bulletList',
        content: [{
          type: 'listItem',
          attrs: { nodeId: 'command' },
          content: [{
            type: 'paragraph',
            content: [{
              type: 'text', text: 'Missing topic',
              marks: [{ type: 'internalLink', attrs: { targetId: 'deleted' } }],
            }],
          }],
        }],
      }],
    })
    editor.commands.setTextSelection(3)

    expect(() => runSkillIntoEditor(
      editor,
      { mode: 'api_key', apiKey: '', oauthCredential: null, modelId: 'gpt-5.1' },
      { id: 'ask', label: 'ask', description: 'Ask', systemPrompt: 'Answer.', agentId: 'general' },
      { id: 'general', name: 'General', description: 'General', systemPrompt: 'Help.', modelId: '', toolIds: [] },
      'question',
    )).toThrow(/no longer exists/)
    expect(bulletTexts(editor)).toEqual(['Missing topic'])
  })

  it('reports generation errors outside the outline and removes failed output', async () => {
    vi.mocked(generateWithPi).mockImplementation(async (_auth, _input, options) => {
      options.onDelta('Partial response')
      throw new Error('Service unavailable')
    })
    const onError = vi.fn()

    const generation = runSkillIntoEditor(
      editor,
      { mode: 'api_key', apiKey: '', oauthCredential: null, modelId: 'gpt-5.1' },
      { id: 'ask', label: 'ask', description: 'Ask', systemPrompt: 'Answer.', agentId: 'general' },
      { id: 'general', name: 'General', description: 'General', systemPrompt: 'Help.', modelId: '', toolIds: [] },
      'question',
      [],
      [],
      onError,
    )
    await generation.promise

    expect(onError).toHaveBeenCalledWith('Service unavailable')
    expect(bulletTexts(editor)).toEqual(['Research topic'])
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

  it('writes structured nested output as nested AI bullets', () => {
    const nodeId = insertAiChild(editor)!

    writeAiOutline(editor, nodeId, [
      { text: 'Finding', children: [{ text: 'Supporting detail' }] },
      { text: 'Second finding' },
    ])

    expect(bulletTexts(editor)).toEqual([
      'Research topic',
      'Finding',
      'Supporting detail',
      'Second finding',
    ])
  })

  it('writes generated images as separate image-only nodes without adding an undo step', () => {
    const nodeId = insertAiChild(editor)!
    const src = `data:image/webp;base64,${btoa('RIFF\u0004\u0000\u0000\u0000WEBP')}`

    writeAiOutline(editor, nodeId, [
      { text: 'Visual' },
      { image: { src, alt: 'A generated visual' } },
    ])

    const image = editor.view.dom.querySelector<HTMLImageElement>('img[data-ai-generated-image]')
    const imageItem = image?.closest('li')
    expect(image?.alt).toBe('A generated visual')
    expect(imageItem?.getAttribute('data-node-type')).toBe('image')
    expect(imageItem?.querySelector('p')).toBeNull()
    expect(bulletTexts(editor)).toEqual(['Research topic', 'Visual'])
    editor.commands.undo()
    expect(bulletTexts(editor)).toEqual(['Research topic'])
  })

  it('marks every generated bullet as AI-written', () => {
    const nodeId = insertAiChild(editor)!

    writeAiOutline(editor, nodeId, [
      { text: 'One', children: [{ text: 'Nested' }] },
      { text: 'Two' },
    ])

    const types: string[] = []
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'listItem') types.push(node.attrs.nodeType)
    })
    expect(types).toEqual(['user', 'ai', 'ai', 'ai'])
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
