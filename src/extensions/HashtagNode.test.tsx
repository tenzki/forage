import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { HashtagNode } from './HashtagNode'

// Mock Tauri IPC — HashtagNode extension calls getTagsMatchingIpc in Suggestion items()
vi.mock('../store/ipc', () => ({
  getTagsMatchingIpc: vi.fn().mockResolvedValue(['rust', 'react']),
}))

// Mock react-dom/client to avoid rendering issues in test env
vi.mock('react-dom/client', () => ({
  createRoot: vi.fn(() => ({
    render: vi.fn(),
    unmount: vi.fn(),
  })),
}))

function createTestEditor(): Editor {
  return new Editor({
    extensions: [
      StarterKit.configure({
        heading: false,
        blockquote: false,
        codeBlock: false,
        horizontalRule: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
      }),
      HashtagNode,
    ],
  })
}

describe('HashtagNode extension', () => {
  let editor: Editor

  beforeEach(() => {
    editor = createTestEditor()
  })

  afterEach(() => {
    editor.destroy()
  })

  it('has name "hashtag"', () => {
    expect(HashtagNode.name).toBe('hashtag')
  })

  it('is registered in the editor schema', () => {
    expect(editor.schema.nodes.hashtag).toBeDefined()
  })

  it('can insert a hashtag node via insertContent', () => {
    editor.commands.insertContent({ type: 'hashtag', attrs: { tag: 'test' } })

    const json = editor.getJSON()
    const doc = json.content ?? []

    // Walk the doc looking for a hashtag node
    let found = false
    for (const block of doc) {
      const inlineContent = block.content ?? []
      for (const inline of inlineContent) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const node = inline as any
        if (node.type === 'hashtag' && node.attrs?.tag === 'test') {
          found = true
        }
      }
    }

    expect(found).toBe(true)
  })

  it('JSON round-trip: getJSON includes hashtag node with correct attrs', () => {
    editor.commands.insertContent({ type: 'hashtag', attrs: { tag: 'roundtrip' } })

    const json = editor.getJSON()
    const jsonStr = JSON.stringify(json)

    expect(jsonStr).toContain('"type":"hashtag"')
    expect(jsonStr).toContain('"tag":"roundtrip"')
  })

  it('JSON round-trip: setContent restores hashtag nodes', () => {
    // Build a doc JSON with a hashtag node
    const docWithHashtag = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Hello ' },
            { type: 'hashtag', attrs: { tag: 'world' } },
          ],
        },
      ],
    }

    editor.commands.setContent(docWithHashtag)

    const json = editor.getJSON()
    const jsonStr = JSON.stringify(json)

    expect(jsonStr).toContain('"type":"hashtag"')
    expect(jsonStr).toContain('"tag":"world"')
  })

  it('renderHTML produces a span with data-hashtag attribute', () => {
    editor.commands.insertContent({ type: 'hashtag', attrs: { tag: 'html-test' } })

    const html = editor.getHTML()

    expect(html).toContain('data-hashtag="html-test"')
    expect(html).toContain('#html-test')
  })

  it('hashtag node has atom: true (not text-based)', () => {
    // NodeType.spec holds the original node spec definition
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nodeType = editor.schema.nodes.hashtag as any
    expect(nodeType.spec.atom).toBe(true)
  })

  it('hashtag node is inline', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nodeType = editor.schema.nodes.hashtag as any
    expect(nodeType.spec.inline).toBe(true)
  })
})
