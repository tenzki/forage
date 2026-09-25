import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { BulletAttributes } from '../editor/extensions'
import { InternalLink } from '../editor/internalLinks'
import {
  AGENT_CONTEXT_MAX_CHARACTERS,
  resolveAgentContext,
  resolveExtensionSkillContext,
  resolveFollowUpContext,
} from './context'

type TextPart = { text: string; targetId?: string }

function item(id: string, text: string | TextPart[], children: object[] = [], attrs: Record<string, unknown> = {}) {
  const parts = typeof text === 'string' ? [{ text }] : text
  return {
    type: 'listItem', attrs: { nodeId: id, ...attrs }, content: [{
      type: 'paragraph',
      content: parts.filter((part) => part.text).map((part) => ({
        type: 'text', text: part.text,
        ...(part.targetId ? { marks: [{ type: 'internalLink', attrs: { targetId: part.targetId } }] } : {}),
      })),
    }, ...(children.length ? [{ type: 'bulletList', content: children }] : [])],
  }
}

function makeEditor(content?: object[]): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit.configure({ trailingNode: false }), BulletAttributes, InternalLink],
    content: { type: 'doc', content: [{ type: 'bulletList', content: content ?? [
      item('a', 'A', [
        item('a1', 'A1'), item('a2', 'A2', [item('a2a', 'A2a')], { collapsed: true }),
        item('command', [
          { text: '/compare ' }, { text: 'B', targetId: 'b' }, { text: ' then ' },
          { text: 'C', targetId: 'c' }, { text: ' and again ' }, { text: 'B', targetId: 'b' },
        ], [item('old-output', 'Old output')]),
      ]),
      item('b', 'B', [item('b1', 'B1')]), item('c', 'C', [item('c1', 'C1')]), item('root-command', '/ask top level'),
    ] }] },
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

  it('includes the full ancestor path without unrelated ancestor subtrees', () => {
    editor = makeEditor([item('grandparent', 'Grandparent', [
      item('unrelated', 'Unrelated branch'), item('parent', 'Parent', [item('note', 'Sibling note'), item('command', '/research')]),
    ])])
    const result = resolveAgentContext(editor.state.doc, 'command')
    expect(result.localNodeIds).toEqual(['grandparent', 'parent', 'note'])
    expect(result.localNodeIds).not.toContain('unrelated')
  })

  it('adds linked branches in appearance order and deduplicates repeats', () => {
    editor = makeEditor()
    const result = resolveAgentContext(editor.state.doc, 'command')
    expect(result.referencedGroups.map((group) => group.targetId)).toEqual(['b', 'c'])
    expect(result.referencedNodeIds).toEqual(['b', 'b1', 'c', 'c1'])
  })

  it('does not duplicate a linked node already in the local branch', () => {
    editor = makeEditor([item('a', 'A', [item('a1', 'A1'), item('command', [{ text: '/ask ' }, { text: 'A1', targetId: 'a1' }])])])
    expect(resolveAgentContext(editor.state.doc, 'command').referencedGroups).toEqual([])
  })

  it('uses stable target identity when the link label is stale', () => {
    editor = makeEditor([item('command', [{ text: '/ask ' }, { text: 'Old name', targetId: 'renamed' }]), item('renamed', 'New name')])
    expect(resolveAgentContext(editor.state.doc, 'command').referencedGroups[0]?.label).toBe('New name')
  })

  it('blocks missing links explicitly', () => {
    editor = makeEditor([item('command', [{ text: '/ask ' }, { text: 'Deleted topic', targetId: 'deleted' }])])
    expect(() => resolveAgentContext(editor!.state.doc, 'command')).toThrow('Referenced node “Deleted topic” no longer exists.')
  })

  it('allows a top-level command with no automatic context', () => {
    editor = makeEditor()
    expect(resolveAgentContext(editor.state.doc, 'root-command')).toMatchObject({ localRootNodeId: null, localNodeIds: [], serialized: '' })
  })

  it('blocks oversized context instead of truncating it', () => {
    editor = makeEditor([item('large', 'x'.repeat(AGENT_CONTEXT_MAX_CHARACTERS), [item('command', '/ask')])])
    expect(() => resolveAgentContext(editor!.state.doc, 'command')).toThrow(/safety limit/)
  })

  it('adds the invocation subtree to reply context, marking agent and user bullets', () => {
    editor = makeEditor([item('a', 'A', [
      item('a1', 'A1'),
      item('command', '/research tides', [
        item('out-1', 'Tides follow the moon.', [item('out-1a', 'Source: NOAA', [], { nodeType: 'ai' })], { nodeType: 'ai' }),
        item('note', 'My own note', [item('note-1', '')]),
      ]),
    ])])
    const followUp = resolveFollowUpContext(editor.state.doc, 'command')

    expect(followUp.context).toEqual(resolveAgentContext(editor.state.doc, 'command'))
    expect(followUp.invocationOutline).toEqual([
      '- [agent] Tides follow the moon.',
      '  - [agent] Source: NOAA',
      '- [user] My own note',
      '  - [user] (empty)',
    ])
    expect(resolveFollowUpContext(editor.state.doc, 'a1').invocationOutline).toEqual([])
  })

  it('counts the invocation subtree against the reply context budget', () => {
    const half = 'x'.repeat(AGENT_CONTEXT_MAX_CHARACTERS / 2)
    editor = makeEditor([item('a', half, [item('command', '/ask', [item('out', half, [], { nodeType: 'ai' })])])])
    expect(() => resolveAgentContext(editor!.state.doc, 'command')).not.toThrow()
    expect(() => resolveFollowUpContext(editor!.state.doc, 'command')).toThrow(/safety limit/)
    editor.destroy()
    editor = makeEditor([item('a', 'A', [item('command', '/ask', Array.from({ length: 100 }, (_, index) => item(`n${index}`, `N${index}`)))])])
    expect(() => resolveFollowUpContext(editor!.state.doc, 'command')).toThrow(/safety limit/)
  })

  it('builds one hierarchy-preserving generic snapshot with stable provenance and no invocation subtree', () => {
    editor = makeEditor()
    const result = resolveExtensionSkillContext(editor.state.doc, 'command', '')

    expect(result.snapshot.provenance).toEqual({
      ancestorPathIds: ['a'], localParentId: 'a', localBranchRootId: 'a', explicitLinkedRootIds: ['b', 'c'],
    })
    expect(result.snapshot.roots.map((root) => root.id)).toEqual(['a', 'b', 'c'])
    expect(result.snapshot.roots[0]?.children?.map((node) => node.id)).toEqual(['a1', 'a2'])
    expect(result.admittedReferenceIds).toEqual(['a', 'a1', 'a2', 'a2a', 'b', 'b1', 'c', 'c1'])
    expect(JSON.stringify(result.snapshot)).not.toContain('old-output')
    expect(new Set(result.admittedReferenceIds).size).toBe(result.admittedReferenceIds.length)
  })

  it('counts the prompt in generic context bounds and rejects missing references before preparation', () => {
    editor = makeEditor([item('parent', 'Parent', [item('command', '/label')])])
    expect(() => resolveExtensionSkillContext(
      editor!.state.doc, 'command', 'x'.repeat(AGENT_CONTEXT_MAX_CHARACTERS),
    )).toThrow(/40000 characters/i)

    editor.destroy()
    editor = makeEditor([item('command', [{ text: '/label ' }, { text: 'Missing', targetId: 'missing' }])])
    expect(() => resolveExtensionSkillContext(editor!.state.doc, 'command', '')).toThrow(/no longer exists/i)
  })
})
