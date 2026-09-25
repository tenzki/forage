import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { BulletAttributes } from './extensions'
import { BulletNote } from './bulletNote'
import { GeneratedImage, GeneratedImageItem, OutlineBulletList, OutlineListItem } from './generatedImage'
import { appendChildBullet, collectBullets, findBullet } from './outlineModel'
import { takeAiOutput } from '../agent/insertIntoEditor'

function item(id: string, text: string, children: object[] = [], nodeType: 'user' | 'ai' = 'user') {
  return {
    type: 'listItem',
    attrs: { nodeId: id, nodeType, collapsed: false, bulletKind: 'bullet', completed: false },
    content: [
      { type: 'paragraph', content: [{ type: 'text', text }] },
      ...(children.length ? [{ type: 'bulletList', content: children }] : []),
    ],
  }
}

function makeEditor(items: object[]): Editor {
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
    ],
    content: { type: 'doc', content: [{ type: 'bulletList', content: items }] },
  })
}

function childTexts(editor: Editor, parentId: string): string[] {
  const parent = findBullet(editor.state.doc, parentId)!
  return collectBullets(editor.state.doc)
    .filter((entry) => entry.ancestorIds[entry.ancestorIds.length - 1] === parentId
      && entry.ancestorIds.length === parent.ancestorIds.length + 1)
    .map((entry) => entry.text)
}

describe('appendChildBullet', () => {
  it('adds the last child of a bullet that already has children', () => {
    const editor = makeEditor([item('alpha', 'Alpha', [item('child', 'Child')])])
    const id = appendChildBullet(editor, 'alpha', 'Appended')

    expect(id).toBeTruthy()
    expect(childTexts(editor, 'alpha')).toEqual(['Child', 'Appended'])
    expect(editor.state.selection.$from.parent.textContent).toBe('Appended')
  })

  it('creates the child list and links segments that carry an href', () => {
    const editor = makeEditor([item('bravo', 'Bravo')])
    appendChildBullet(editor, 'bravo', [{ text: '“Quote” — ' }, { text: 'example.com', href: 'https://example.com/' }])

    expect(childTexts(editor, 'bravo')).toEqual(['“Quote” — example.com'])
    const json = JSON.stringify(editor.getJSON())
    expect(json).toContain('"href":"https://example.com/"')
  })
})

describe('takeAiOutput', () => {
  it('removes only agent output under the invocation and returns it as lines', () => {
    const editor = makeEditor([item('run', '/research topic', [
      item('mine', 'My own note'),
      item('ai-1', 'First finding', [item('ai-1a', 'Detail', [], 'ai')], 'ai'),
    ])])

    expect(takeAiOutput(editor, 'run')).toEqual(['- First finding', '  - Detail'])
    expect(childTexts(editor, 'run')).toEqual(['My own note'])
  })

  it('drops a child list made only of agent output', () => {
    const editor = makeEditor([item('run', '/research topic', [item('ai-1', 'Only finding', [], 'ai')])])

    expect(takeAiOutput(editor, 'run')).toEqual(['- Only finding'])
    expect(childTexts(editor, 'run')).toEqual([])
    expect(findBullet(editor.state.doc, 'run')?.node.childCount).toBe(1)
  })
})
