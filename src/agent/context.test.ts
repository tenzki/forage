import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { contextStrategyForPreset } from './definitions'
import { BulletAttributes } from '../editor/extensions'
import { resolveSkillContext } from './context'

function item(id: string, text: string, children: object[] = [], nodeType = 'user') {
  return {
    type: 'listItem', attrs: { nodeId: id, nodeType },
    content: [
      { type: 'paragraph', content: text ? [{ type: 'text', text }] : undefined },
      ...(children.length ? [{ type: 'bulletList', content: children }] : []),
    ],
  }
}

function makeEditor(): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit, BulletAttributes],
    content: {
      type: 'doc', content: [{ type: 'bulletList', content: [
        item('a', 'A', [
          item('a1', 'A1', [item('a1a', 'A1a')]),
          item('a2', 'A2'),
          item('command', '/summarize'),
        ]),
        item('b', 'B', [item('b1', 'B1', [], 'ai')]),
        item('root-command', '/summarize-above'),
      ] }],
    },
  })
}

describe('skill context strategies', () => {
  let editor: Editor | null = null
  afterEach(() => editor?.destroy())

  it('selects a parent branch while excluding the invocation command', () => {
    editor = makeEditor()
    const result = resolveSkillContext(editor.state.doc, 'command', contextStrategyForPreset('parent-branch'))

    expect(result.anchorNodeId).toBe('a')
    expect(result.nodeIds).toEqual(['a', 'a1', 'a1a', 'a2'])
    expect(result.lines).toEqual(['- A', '  - A1', '    - A1a', '  - A2'])
  })

  it('selects the complete previous sibling branch', () => {
    editor = makeEditor()
    const result = resolveSkillContext(editor.state.doc, 'root-command', contextStrategyForPreset('previous-branch'))

    expect(result.nodeIds).toEqual(['b', 'b1'])
  })

  it('can include sibling texts without their descendants', () => {
    editor = makeEditor()
    const result = resolveSkillContext(editor.state.doc, 'a1', contextStrategyForPreset('current-level'))

    expect(result.nodeIds).toEqual(['a1', 'a2', 'command'])
    expect(result.nodeIds).not.toContain('a1a')
  })

  it('selects complete current and sibling branches for neighboring branches', () => {
    editor = makeEditor()
    const result = resolveSkillContext(editor.state.doc, 'a', contextStrategyForPreset('neighboring-branches'))

    expect(result.nodeIds).toEqual(['a', 'a1', 'a1a', 'a2', 'command', 'b', 'b1', 'root-command'])
  })

  it('applies depth and AI-node filters', () => {
    editor = makeEditor()
    const branch = contextStrategyForPreset('current-branch')
    branch.selectors = [{ kind: 'self' }, { kind: 'descendants', maxDepth: 1 }]
    expect(resolveSkillContext(editor.state.doc, 'a', branch).nodeIds).not.toContain('a1a')

    const previous = contextStrategyForPreset('previous-branch')
    previous.filters.includeAiNodes = false
    expect(resolveSkillContext(editor.state.doc, 'root-command', previous).nodeIds).toEqual(['b'])
  })

  it('blocks an oversized context when configured to do so', () => {
    editor = makeEditor()
    const strategy = contextStrategyForPreset('current-branch')
    strategy.budget = { maxNodes: 2, maxCharacters: 10_000, overflow: 'block' }

    expect(() => resolveSkillContext(editor!.state.doc, 'a', strategy)).toThrow(/exceeds/)
  })
})
