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
import { AgentStreamingText } from '../editor/agentStreamingText'
import {
  GeneratedImage,
  GeneratedImageItem,
  OutlineBulletList,
  OutlineListItem,
} from '../editor/generatedImage'
import { generateWithPi } from './piGeneration'
import {
  commitExtensionSkillResult,
  commitStructuredAgentResult,
  commitStructuredAgentResultInto,
  currentListItemId,
  insertAiChild,
  insertAiChildUnder,
  insertExtensionSkillResult,
  removeCurrentSlashCommand,
  runSkillIntoEditor,
  skillActivityLabel,
  setCurrentBulletText,
  siblingContext,
  writeAiOutline,
  prepareAiOutline,
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
      StarterKit.configure({ bulletList: false, listItem: false, trailingNode: false }),
      OutlineListItem,
      OutlineBulletList,
      GeneratedImageItem,
      GeneratedImage,
      BulletAttributes,
      BulletNote,
      InternalLink,
      AgentStreamingText,
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
      { id: 'ask', label: 'ask', description: 'Ask', systemPrompt: 'Answer.', agentId: 'general', requiredToolIds: [] },
      { id: 'general', name: 'General', description: 'General', systemPrompt: 'Help.', toolIds: [] },
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
      { id: 'ask', label: 'ask', description: 'Ask', systemPrompt: 'Answer.', agentId: 'general', requiredToolIds: [] },
      { id: 'general', name: 'General', description: 'General', systemPrompt: 'Help.', toolIds: [] },
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

  it('decorates only the newly received text without persisting presentation markup', () => {
    const nodeId = insertAiChild(editor)!
    writeAiText(editor, nodeId, 'Hello', '')
    expect(editor.view.dom.querySelector('.t-stream-w')?.textContent).toBe('Hello')

    writeAiText(editor, nodeId, 'Hello world', 'Hello')
    expect(editor.view.dom.querySelector('.t-stream-w')?.textContent).toBe(' world')
    expect(JSON.stringify(editor.getJSON())).not.toContain('t-stream-w')
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

  it('formats Markdown and bare links in completed agent output', () => {
    const nodeId = insertAiChild(editor)!

    writeAiOutline(editor, nodeId, [{
      text: 'Read [OpenAI](https://openai.com) and https://example.com/docs.',
    }])

    let generatedParagraph: Parameters<Parameters<typeof editor.state.doc.descendants>[0]>[0] | undefined
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'listItem' && node.attrs.nodeType === 'ai') {
        generatedParagraph = node.firstChild ?? undefined
        return false
      }
      return undefined
    })
    expect(generatedParagraph?.textContent).toBe('Read OpenAI and https://example.com/docs.')
    const links: Array<{ text: string; href: string }> = []
    generatedParagraph?.descendants((node) => {
      if (!node.isText) return
      const link = node.marks.find((mark) => mark.type.name === 'link')
      if (link) links.push({ text: node.text ?? '', href: link.attrs.href })
    })
    expect(links).toEqual([
      { text: 'OpenAI', href: 'https://openai.com' },
      { text: 'https://example.com/docs', href: 'https://example.com/docs' },
    ])
  })

  it('writes generated images as separate image-only nodes without adding an undo step', async () => {
    const nodeId = insertAiChild(editor)!
    const src = `data:image/webp;base64,${btoa('RIFF\u0004\u0000\u0000\u0000WEBP')}`

    const stored = await prepareAiOutline([
      { text: 'Visual' },
      { image: { src, alt: 'A generated visual' } },
    ], {
      ingestGeneratedImage: async () => ({ assetId: 'a'.repeat(64), alt: 'A generated visual' }),
    })
    writeAiOutline(editor, nodeId, stored)

    const image = editor.view.dom.querySelector<HTMLImageElement>('img[data-ai-generated-image]')
    const imageItem = image?.closest('li')
    expect(image?.alt).toBe('A generated visual')
    expect(image?.dataset.assetId).toBe('a'.repeat(64))
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

  it('commits only the terminal structured result as one coherent undo change', () => {
    editor.destroy()
    editor = makeEditor('/research Compare options')
    editor.commands.setTextSelection(3)
    const invocationNodeId = currentListItemId(editor)!

    commitStructuredAgentResult(editor, invocationNodeId, 'research', {
      version: 1,
      nodes: [{ type: 'text', text: 'Summary', children: [{ type: 'text', text: 'Evidence' }] }],
      sources: [],
    })

    expect(bulletTexts(editor)).toEqual(['Compare options', 'Summary', 'Evidence'])
    editor.commands.undo()
    expect(bulletTexts(editor)).toEqual(['/research Compare options'])
  })

  it('rejects reference-bearing results until the reference-aware formatter is installed', () => {
    editor.destroy()
    editor = makeEditor('/research Compare options')
    editor.commands.setTextSelection(3)
    const invocationNodeId = currentListItemId(editor)!

    expect(() => commitStructuredAgentResult(editor, invocationNodeId, 'research', {
      version: 2,
      nodes: [{
        type: 'text',
        segments: [{ type: 'internal-reference', nodeId: 'idea-1', label: 'Idea one' }],
      }],
      sources: [],
    })).toThrow(/reference-aware materialization/i)
    expect(bulletTexts(editor)).toEqual(['/research Compare options'])
  })

  it('materializes generic text and references atomically as ordinary linked bullets', () => {
    editor.destroy()
    editor = makeEditor('/label Compare options')
    editor.commands.setTextSelection(3)
    const invocationNodeId = currentListItemId(editor)!
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, {
      type: 'listItem',
      attrs: { nodeId: 'idea-1' },
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Original idea' }] }],
    })

    const nodeIds = commitExtensionSkillResult(editor, invocationNodeId, 'label', 'run-one', {
      version: 2,
      nodes: [{
        type: 'text',
        segments: [
          { type: 'text', text: 'Selected: ' },
          { type: 'internal-reference', nodeId: 'idea-1', label: 'Idea one' },
        ],
        children: [{ type: 'text', segments: [{ type: 'text', text: 'Static detail' }] }],
      }],
      sources: [],
    }, ['idea-1'])

    expect(nodeIds).toEqual(['extension-result-run-one-0'])
    expect(bulletTexts(editor)).toEqual(['Compare options', 'Selected: Idea one', 'Static detail', 'Original idea'])
    const link = editor.view.dom.querySelector<HTMLAnchorElement>('a[data-internal-node-id="idea-1"]')
    expect(link?.textContent).toBe('Idea one')
    expect(link?.getAttribute('href')).toBe('#node=idea-1')
    expect(JSON.stringify(editor.getJSON())).not.toContain('label_notes')

    editor.commands.undo()
    expect(bulletTexts(editor)).toEqual(['/label Compare options', 'Original idea'])
    editor.commands.redo()
    expect(bulletTexts(editor)).toEqual(['Compare options', 'Selected: Idea one', 'Static detail', 'Original idea'])
  })

  it('replaces an empty invocation with a single result root and places its children under it', () => {
    editor.destroy()
    editor = makeEditor('/label')
    editor.commands.setTextSelection(3)
    const invocationNodeId = currentListItemId(editor)!
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, {
      type: 'listItem',
      attrs: { nodeId: 'idea-1' },
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Original idea' }] }],
    })
    const result = {
      version: 2 as const,
      nodes: [{
        type: 'text' as const,
        segments: [{ type: 'text' as const, text: 'How promising is this?' }],
        children: [{
          type: 'text' as const,
          segments: [
            { type: 'internal-reference' as const, nodeId: 'idea-1', label: 'Idea one' },
            { type: 'text' as const, text: ' - Strong (1.62); confidence: 90.00%' },
          ],
        }],
      }],
      sources: [],
    }

    expect(commitExtensionSkillResult(editor, invocationNodeId, 'label', 'run-hoist', result, ['idea-1']))
      .toEqual([invocationNodeId])
    expect(bulletTexts(editor)).toEqual(['How promising is this?', 'Idea one - Strong (1.62); confidence: 90.00%', 'Original idea'])
    expect(editor.state.doc.firstChild?.firstChild?.attrs.nodeId).toBe(invocationNodeId)
    expect(insertExtensionSkillResult(editor, 'idea-1', 'run-hoist', result, ['idea-1']))
      .toEqual(['extension-result-run-hoist-0'])
    expect(bulletTexts(editor)).toHaveLength(3)

    editor.commands.undo()
    expect(bulletTexts(editor)).toEqual(['/label', 'Original idea'])
    editor.commands.redo()
    expect(bulletTexts(editor)).toEqual(['How promising is this?', 'Idea one - Strong (1.62); confidence: 90.00%', 'Original idea'])
  })

  it('reorders admitted siblings in place and removes an empty invocation in one undoable step', () => {
    editor.destroy()
    editor = makeEditor('/label')
    editor.commands.setTextSelection(3)
    const invocationNodeId = currentListItemId(editor)!
    ;['idea-1', 'idea-2', 'idea-3'].forEach((nodeId, index) => {
      editor.commands.insertContentAt(editor.state.doc.content.size - 1, {
        type: 'listItem',
        attrs: { nodeId },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: `Idea ${index + 1}` }] }],
      })
    })
    const result = { version: 2 as const, nodes: [], sources: [], reorder: { nodeIds: ['idea-3', 'idea-1'] } }

    expect(commitExtensionSkillResult(editor, invocationNodeId, 'label', 'run-reorder', result, ['idea-1', 'idea-3']))
      .toEqual(['idea-3', 'idea-1'])
    // Idea 2 was not reordered, so it keeps its slot between the moved bullets.
    expect(bulletTexts(editor)).toEqual(['Idea 3', 'Idea 2', 'Idea 1'])
    expect(insertExtensionSkillResult(editor, 'idea-2', 'run-reorder', result, ['idea-1', 'idea-3']))
      .toEqual(['idea-3', 'idea-1'])
    expect(bulletTexts(editor)).toEqual(['Idea 3', 'Idea 2', 'Idea 1'])

    editor.commands.undo()
    expect(bulletTexts(editor)).toEqual(['/label', 'Idea 1', 'Idea 2', 'Idea 3'])
    editor.commands.redo()
    expect(bulletTexts(editor)).toEqual(['Idea 3', 'Idea 2', 'Idea 1'])
  })

  it('keeps a prompted invocation and rejects reorders of unadmitted or separated bullets', () => {
    editor.destroy()
    editor = makeEditor('/label focus on cost')
    editor.commands.setTextSelection(3)
    const invocationNodeId = currentListItemId(editor)!
    ;['idea-1', 'idea-2'].forEach((nodeId, index) => {
      editor.commands.insertContentAt(editor.state.doc.content.size - 1, {
        type: 'listItem',
        attrs: { nodeId },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: `Idea ${index + 1}` }] }],
      })
    })
    const result = { version: 2 as const, nodes: [], sources: [], reorder: { nodeIds: ['idea-2', 'idea-1'] } }
    const before = editor.getJSON()
    expect(() => commitExtensionSkillResult(editor, invocationNodeId, 'label', 'run-bad', result, ['idea-1']))
      .toThrow(/unadmitted node/i)
    expect(() => commitExtensionSkillResult(editor, invocationNodeId, 'label', 'run-bad', {
      ...result, reorder: { nodeIds: ['idea-2', 'missing'] },
    }, ['idea-2', 'missing'])).toThrow(/no longer available/i)
    expect(editor.getJSON()).toEqual(before)

    commitExtensionSkillResult(editor, invocationNodeId, 'label', 'run-prompted', result, ['idea-1', 'idea-2'])
    expect(bulletTexts(editor)).toEqual(['focus on cost', 'Idea 2', 'Idea 1'])
  })

  it('rejects an unadmitted generic reference without partially changing the outline', () => {
    editor.destroy()
    editor = makeEditor('/label Compare options')
    editor.commands.setTextSelection(3)
    const invocationNodeId = currentListItemId(editor)!
    const before = editor.getJSON()

    expect(() => commitExtensionSkillResult(editor, invocationNodeId, 'label', 'run-two', {
      version: 2,
      nodes: [{
        type: 'text',
        segments: [{ type: 'internal-reference', nodeId: 'outside', label: 'Outside' }],
      }],
      sources: [],
    }, ['inside'])).toThrow(/unadmitted reference/i)
    expect(editor.getJSON()).toEqual(before)
  })

  it('replaces live streamed text with the terminal structured result', () => {
    setCurrentBulletText(editor, '/research topic')
    const invocationNodeId = currentListItemId(editor)!
    const outputNodeId = insertAiChildUnder(editor, invocationNodeId)!
    writeAiText(editor, outputNodeId, 'Partial response', '')

    const [resultNodeId] = commitStructuredAgentResultInto(editor, invocationNodeId, outputNodeId, 'research', {
      version: 1,
      nodes: [{ type: 'text', text: 'Final response' }],
      sources: [],
    })

    expect(resultNodeId).toBe(outputNodeId)
    expect(bulletTexts(editor)).toEqual(['topic', 'Final response'])
  })

  it('does not move the caret while text streams in', () => {
    const nodeId = insertAiChild(editor)!
    const before = editor.state.selection.from

    writeAiText(editor, nodeId, 'First finding\nSecond finding')

    expect(editor.state.selection.from).toBe(before)
  })
})
