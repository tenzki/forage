import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { BulletAttributes } from '../editor/extensions'
import { InternalLink } from '../editor/internalLinks'
import {
  AGENT_CONTEXT_MAX_CHARACTERS,
  resolveAgentContext,
} from './context'

type TextPart = { text: string; targetId?: string }

function item(
  id: string,
  text: string | TextPart[],
  children: object[] = [],
  attrs: Record<string, unknown> = {},
) {
  const parts = typeof text === 'string' ? [{ text }] : text
  return {
    type: 'listItem',
    attrs: { nodeId: id, ...attrs },
    content: [
      {
        type: 'paragraph',
        content: parts.filter((part) => part.text).map((part) => ({
          type: 'text',
          text: part.text,
          ...(part.targetId
            ? { marks: [{ type: 'internalLink', attrs: { targetId: part.targetId } }] }
            : {}),
        })),
      },
      ...(children.length ? [{ type: 'bulletList', content: children }] : []),
    ],
  }
}

function makeEditor(content?: object[]): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit.configure({ trailingNode: false }), BulletAttributes, InternalLink],
    content: {
      type: 'doc',
      content: [{
        type: 'bulletList',
        content: content ?? [
          item('a', 'A', [
            item('a1', 'A1'),
            item('a2', 'A2', [item('a2a', 'A2a')], { collapsed: true }),
            item('command', [
              { text: '/compare ' },
              { text: 'B', targetId: 'b' },
              { text: ' then ' },
              { text: 'C', targetId: 'c' },
              { text: ' and again ' },
              { text: 'B', targetId: 'b' },
            ], [item('old-output', 'Old output')]),
          ]),
          item('b', 'B', [item('b1', 'B1')]),
          item('c', 'C', [item('c1', 'C1')]),
          item('root-command', '/ask top level'),
        ],
      }],
    },
  })
}

describe('agent branch and reference context', () => {
  let editor: Editor | null = null
  afterEach(() => editor?.destroy())

  it('includes the complete parent branch but excludes the invocation subtree', () => {
    editor = makeEditor()
    const result = resolveAgentContext(editor.state.doc, 'command')

    expect(result.localRootNodeId).toBe('a')
    expect(result.localNodeIds).toEqual(['a', 'a1', 'a2', 'a2a'])
    expect(result.localNodeIds).not.toContain('old-output')
    expect(result.serialized).toContain('Local branch:\n- A\n  - A1\n  - A2\n    - A2a')
  })

  it('includes the full ancestor path without adding unrelated ancestor subtrees', () => {
    editor = makeEditor([
      item('grandparent', 'Grandparent', [
        item('unrelated', 'Unrelated branch'),
        item('parent', 'Parent', [
          item('note', 'Sibling note'),
          item('command', '/research'),
        ]),
      ]),
    ])

    const result = resolveAgentContext(editor.state.doc, 'command')

    expect(result.localRootNodeId).toBe('grandparent')
    expect(result.localNodeIds).toEqual(['grandparent', 'parent', 'note'])
    expect(result.localNodeIds).not.toContain('unrelated')
    expect(result.serialized).toBe(
      'Local branch:\n- Grandparent\n  - Parent\n    - Sibling note',
    )
  })

  it('adds referenced branches in first-appearance order and deduplicates repeats', () => {
    editor = makeEditor()
    const result = resolveAgentContext(editor.state.doc, 'command')

    expect(result.referencedGroups.map((group) => group.targetId)).toEqual(['b', 'c'])
    expect(result.referencedNodeIds).toEqual(['b', 'b1', 'c', 'c1'])
    expect(result.serialized).toContain(
      'Referenced nodes:\n[B]\n- B\n  - B1\n\n[C]\n- C\n  - C1',
    )
  })

  it('does not duplicate a referenced node already present in the local branch', () => {
    editor = makeEditor([
      item('a', 'A', [
        item('a1', 'A1'),
        item('command', [{ text: '/ask ' }, { text: 'A1', targetId: 'a1' }]),
      ]),
    ])

    const result = resolveAgentContext(editor.state.doc, 'command')
    expect(result.localNodeIds).toEqual(['a', 'a1'])
    expect(result.referencedGroups).toEqual([])
  })

  it('uses stable target identity when the displayed link label is stale', () => {
    editor = makeEditor([
      item('command', [{ text: '/ask ' }, { text: 'Old name', targetId: 'renamed' }]),
      item('renamed', 'New name'),
    ])

    const result = resolveAgentContext(editor.state.doc, 'command')
    expect(result.referencedGroups[0]?.label).toBe('New name')
    expect(result.serialized).toContain('[New name]\n- New name')
  })

  it('blocks a missing structured reference explicitly', () => {
    editor = makeEditor([
      item('command', [{ text: '/ask ' }, { text: 'Deleted topic', targetId: 'deleted' }]),
    ])

    expect(() => resolveAgentContext(editor!.state.doc, 'command')).toThrow(
      'Referenced node “Deleted topic” no longer exists.',
    )
  })

  it('allows a top-level command with no automatic context', () => {
    editor = makeEditor()
    const result = resolveAgentContext(editor.state.doc, 'root-command')

    expect(result.localRootNodeId).toBeNull()
    expect(result.localNodeIds).toEqual([])
    expect(result.serialized).toBe('')
  })

  it('blocks oversized context instead of truncating it', () => {
    editor = makeEditor([
      item('large', 'x'.repeat(AGENT_CONTEXT_MAX_CHARACTERS), [item('command', '/ask')]),
    ])

    expect(() => resolveAgentContext(editor!.state.doc, 'command')).toThrow(/safety limit/)
  })
})
