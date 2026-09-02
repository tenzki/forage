// Executable form of docs/outline-structure-rules.md.
//
// Every test is named with the rule ID it enforces. Tests drive the same public
// surface the app does — keymap shortcuts and the exported move helpers — so
// they stay valid across refactors of the underlying implementation.

import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { TextSelection } from '@tiptap/pm/state'
import { BulletAttributes, OutlinerKeymap } from './extensions'
import { BulletNote } from './bulletNote'
import { GeneratedImage, GeneratedImageItem, OutlineBulletList, OutlineListItem } from './generatedImage'
import { InternalLink } from './internalLinks'
import { OutlinerUi } from './outlinerUi'
import { collectBullets, findBullet, moveBulletTo, type MovePlacement } from './outlineModel'

const EMPTY = '∅'

interface OutlineSpec {
  id: string
  text: string
  collapsed: boolean
  children: OutlineSpec[]
}

/**
 * Parse an indented outline literal into a spec tree. Two spaces per level.
 * A leading `>` marks the bullet collapsed. Bullet text doubles as its nodeId,
 * so assertions can name bullets directly.
 */
function parseOutline(source: string): OutlineSpec[] {
  const roots: OutlineSpec[] = []
  const stack: Array<{ depth: number; node: OutlineSpec }> = []
  for (const line of source.split('\n')) {
    if (!line.trim()) continue
    const indent = line.length - line.trimStart().length
    if (indent % 2 !== 0) throw new Error(`Outline indent must be even: "${line}"`)
    const depth = indent / 2
    let text = line.trim()
    const collapsed = text.startsWith('>')
    if (collapsed) text = text.slice(1).trim()
    const node: OutlineSpec = { id: text, text: text === EMPTY ? '' : text, collapsed, children: [] }
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop()
    const parent = stack[stack.length - 1]
    if (!parent && depth !== 0) throw new Error(`Orphan outline line: "${line}"`)
    if (parent) parent.node.children.push(node)
    else roots.push(node)
    stack.push({ depth, node })
  }
  return roots
}

function specToJson(spec: OutlineSpec): object {
  return {
    type: 'listItem',
    attrs: {
      nodeId: spec.id,
      nodeType: 'user',
      collapsed: spec.collapsed,
      bulletKind: 'bullet',
      completed: false,
      systemRole: null,
      dailyDate: null,
    },
    content: [
      {
        type: 'paragraph',
        ...(spec.text ? { content: [{ type: 'text', text: spec.text }] } : {}),
      },
      ...(spec.children.length
        ? [{ type: 'bulletList', content: spec.children.map(specToJson) }]
        : []),
    ],
  }
}

function makeEditor(source: string): Editor {
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
      OutlinerKeymap,
      OutlinerUi,
    ],
    content: {
      type: 'doc',
      content: [{ type: 'bulletList', content: parseOutline(source).map(specToJson) }],
    },
  })
}

/** Render the live document back into the same literal format the tests author. */
function render(editor: Editor): string {
  const lines: string[] = []
  for (const entry of collectBullets(editor.state.doc)) {
    const indent = '  '.repeat(entry.ancestorIds.length)
    const marker = entry.node.attrs.collapsed ? '> ' : ''
    lines.push(`${indent}${marker}${entry.text || EMPTY}`)
  }
  return lines.join('\n')
}

/** Strip the leading newline and common indentation from an outline literal. */
function outline(strings: TemplateStringsArray, ...values: unknown[]): string {
  const raw = strings.reduce((acc, part, index) => acc + part + (values[index] ?? ''), '')
  const lines = raw.split('\n').filter((line) => line.trim())
  const shortest = Math.min(...lines.map((line) => line.length - line.trimStart().length))
  return lines.map((line) => line.slice(shortest)).join('\n')
}

function bullet(editor: Editor, id: string) {
  const entry = findBullet(editor.state.doc, id)
  if (!entry) throw new Error(`No bullet "${id}" in outline:\n${render(editor)}`)
  return entry
}

/** Put the caret in `id`. `offset` defaults to the end of the bullet's text. */
function place(editor: Editor, id: string, offset?: number): void {
  const entry = bullet(editor, id)
  editor.commands.setTextSelection(entry.pos + 2 + (offset ?? entry.text.length))
}

/** Select from the start of `fromId` to the end of `toId`, spanning bullets. */
function selectAcross(editor: Editor, fromId: string, toId: string): void {
  const from = bullet(editor, fromId)
  const to = bullet(editor, toId)
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(
    editor.state.doc,
    from.pos + 2,
    to.pos + 2 + to.text.length,
  )))
}

/**
 * Dispatch through ProseMirror's real `handleKeyDown` path rather than
 * `commands.keyboardShortcut`, which wraps the handler in its own transaction
 * and can move the selection afterwards. Caret rules are only meaningful when
 * exercised the way a keystroke actually arrives.
 */
function press(editor: Editor, shortcut: string): void {
  const parts = shortcut.split('-')
  const key = parts[parts.length - 1]
  const modifiers = new Set(parts.slice(0, -1))
  const event = new KeyboardEvent('keydown', {
    key,
    shiftKey: modifiers.has('Shift'),
    altKey: modifiers.has('Alt'),
    ctrlKey: modifiers.has('Ctrl'),
    metaKey: modifiers.has('Mod') || modifiers.has('Meta'),
    bubbles: true,
    cancelable: true,
  })
  editor.view.someProp('handleKeyDown', (handler) => handler(editor.view, event))
}

/** Id of the bullet holding the caret. */
function caretBulletId(editor: Editor): string | null {
  const { $from } = editor.state.selection
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth)
    if (node.type.name === 'listItem') return node.attrs.nodeId ?? null
  }
  return null
}

/** Caret offset within its bullet's paragraph. */
function caretOffset(editor: Editor): number {
  return editor.state.selection.$from.parentOffset
}

function ids(editor: Editor): string[] {
  return collectBullets(editor.state.doc).map((entry) => entry.id)
}

function drop(editor: Editor, sourceId: string, targetId: string, placement: MovePlacement): boolean {
  return moveBulletTo(editor, sourceId, targetId, placement)
}

describe('outline structure rules', () => {
  let editor: Editor

  afterEach(() => {
    editor?.destroy()
  })

  // ---------------------------------------------------------------- IND: Tab

  describe('IND — indent (Tab)', () => {
    it('IND-01: a bullet with no previous sibling cannot indent', () => {
      editor = makeEditor(outline`
        a
          a1
          a2
      `)
      place(editor, 'a1')
      press(editor, 'Tab')

      expect(render(editor)).toBe(outline`
        a
          a1
          a2
      `)
    })

    it('IND-01: a first top-level bullet cannot indent', () => {
      editor = makeEditor(outline`
        a
        b
      `)
      place(editor, 'a')
      press(editor, 'Tab')

      expect(render(editor)).toBe(outline`
        a
        b
      `)
    })

    it('IND-02: the bullet becomes the LAST child of its previous sibling', () => {
      editor = makeEditor(outline`
        a
          a1
          a2
        b
      `)
      place(editor, 'b')
      press(editor, 'Tab')

      expect(render(editor)).toBe(outline`
        a
          a1
          a2
          b
      `)
    })

    it('IND-03: the whole branch moves with the indented bullet', () => {
      editor = makeEditor(outline`
        a
        b
          b1
            b1x
          b2
      `)
      place(editor, 'b')
      press(editor, 'Tab')

      expect(render(editor)).toBe(outline`
        a
          b
            b1
              b1x
            b2
      `)
    })

    it('IND-04: a collapsed previous sibling expands to reveal the indented bullet', () => {
      editor = makeEditor(outline`
        > a
          a1
        b
      `)
      place(editor, 'b')
      press(editor, 'Tab')

      expect(render(editor)).toBe(outline`
        a
          a1
          b
      `)
    })

    it('IND-05: following siblings are unaffected', () => {
      editor = makeEditor(outline`
        a
        b
        c
        d
      `)
      place(editor, 'b')
      press(editor, 'Tab')

      expect(render(editor)).toBe(outline`
        a
          b
        c
        d
      `)
    })

    it('IND-06: the caret keeps its bullet and offset', () => {
      editor = makeEditor(outline`
        a
        bravo
      `)
      place(editor, 'bravo', 3)
      press(editor, 'Tab')

      expect(caretBulletId(editor)).toBe('bravo')
      expect(caretOffset(editor)).toBe(3)
    })

    it('IND-07: nesting has no depth limit', () => {
      editor = makeEditor(outline`
        a
          b
            c
              d
        e
      `)
      place(editor, 'e')
      press(editor, 'Tab')
      place(editor, 'e')
      press(editor, 'Tab')
      place(editor, 'e')
      press(editor, 'Tab')
      place(editor, 'e')
      press(editor, 'Tab')

      expect(render(editor)).toBe(outline`
        a
          b
            c
              d
                e
      `)
    })

    it('IND-08: a multi-bullet selection indents every selection root', () => {
      editor = makeEditor(outline`
        a
        b
        c
      `)
      selectAcross(editor, 'b', 'c')
      press(editor, 'Tab')

      expect(render(editor)).toBe(outline`
        a
          b
          c
      `)
    })

    it('IND-08: a multi-bullet selection is a no-op when any root cannot indent', () => {
      editor = makeEditor(outline`
        a
        b
      `)
      selectAcross(editor, 'a', 'b')
      press(editor, 'Tab')

      expect(render(editor)).toBe(outline`
        a
        b
      `)
    })

    it('IND-08: a selected descendant moves with its selected ancestor, not on its own', () => {
      editor = makeEditor(outline`
        a
        b
          b1
      `)
      selectAcross(editor, 'b', 'b1')
      press(editor, 'Tab')

      expect(render(editor)).toBe(outline`
        a
          b
            b1
      `)
    })

    it('INV-01: indent preserves every nodeId', () => {
      editor = makeEditor(outline`
        a
        b
          b1
      `)
      const before = ids(editor)
      place(editor, 'b')
      press(editor, 'Tab')

      expect(ids(editor).sort()).toEqual(before.sort())
    })

    it('INV-04: indent is a single undo step', () => {
      editor = makeEditor(outline`
        a
        b
      `)
      place(editor, 'b')
      press(editor, 'Tab')
      editor.commands.undo()

      expect(render(editor)).toBe(outline`
        a
        b
      `)
    })
  })

  // --------------------------------------------------------- OUT: Shift-Tab

  describe('OUT — outdent (Shift+Tab)', () => {
    it('OUT-01: a top-level bullet cannot outdent', () => {
      editor = makeEditor(outline`
        a
        b
      `)
      place(editor, 'b')
      press(editor, 'Shift-Tab')

      expect(render(editor)).toBe(outline`
        a
        b
      `)
    })

    it('OUT-02: the bullet lands immediately after its former parent', () => {
      editor = makeEditor(outline`
        a
          a1
        z
      `)
      place(editor, 'a1')
      press(editor, 'Shift-Tab')

      expect(render(editor)).toBe(outline`
        a
        a1
        z
      `)
    })

    it('OUT-03: following siblings stay with the former parent (logical outdent)', () => {
      editor = makeEditor(outline`
        a
          b
          c
          d
      `)
      place(editor, 'c')
      press(editor, 'Shift-Tab')

      expect(render(editor)).toBe(outline`
        a
          b
          d
        c
      `)
    })

    it('OUT-04: the outdented bullet keeps its own branch', () => {
      editor = makeEditor(outline`
        a
          b
          c
            c1
            c2
          d
      `)
      place(editor, 'c')
      press(editor, 'Shift-Tab')

      expect(render(editor)).toBe(outline`
        a
          b
          d
        c
          c1
          c2
      `)
    })

    it('OUT-05: preceding siblings stay with the former parent', () => {
      editor = makeEditor(outline`
        a
          b
            b1
          c
      `)
      place(editor, 'c')
      press(editor, 'Shift-Tab')

      expect(render(editor)).toBe(outline`
        a
          b
            b1
        c
      `)
    })

    it('OUT-06: a parent emptied by outdent loses its child list', () => {
      editor = makeEditor(outline`
        a
          a1
      `)
      place(editor, 'a1')
      press(editor, 'Shift-Tab')

      expect(render(editor)).toBe(outline`
        a
        a1
      `)
      expect(bullet(editor, 'a').node.childCount).toBe(1)
    })

    it('OUT-07: the caret keeps its bullet and offset', () => {
      editor = makeEditor(outline`
        a
          bravo
      `)
      place(editor, 'bravo', 2)
      press(editor, 'Shift-Tab')

      expect(caretBulletId(editor)).toBe('bravo')
      expect(caretOffset(editor)).toBe(2)
    })

    it('OUT-08: a bullet with children outdents normally, even mid-list', () => {
      editor = makeEditor(outline`
        a
          b
          c
            c1
          d
      `)
      place(editor, 'c')
      press(editor, 'Shift-Tab')

      expect(bullet(editor, 'c').ancestorIds).toEqual([])
      expect(bullet(editor, 'c1').ancestorIds).toEqual(['c'])
      expect(bullet(editor, 'd').ancestorIds).toEqual(['a'])
    })

    it('OUT-09: a multi-bullet selection outdents every selection root', () => {
      editor = makeEditor(outline`
        a
          b
          c
      `)
      selectAcross(editor, 'b', 'c')
      press(editor, 'Shift-Tab')

      expect(render(editor)).toBe(outline`
        a
        b
        c
      `)
    })

    it('OUT-09: a multi-bullet selection is a no-op when any root cannot outdent', () => {
      editor = makeEditor(outline`
        a
          a1
        b
      `)
      selectAcross(editor, 'a1', 'b')
      press(editor, 'Shift-Tab')

      expect(render(editor)).toBe(outline`
        a
          a1
        b
      `)
    })

    it('INV-05: outdent preserves collapse state of the branch', () => {
      editor = makeEditor(outline`
        a
          > b
            b1
          c
      `)
      place(editor, 'b')
      press(editor, 'Shift-Tab')

      expect(render(editor)).toBe(outline`
        a
          c
        > b
          b1
      `)
    })

    it('INV-04: outdent is a single undo step', () => {
      editor = makeEditor(outline`
        a
          b
          c
          d
      `)
      place(editor, 'c')
      press(editor, 'Shift-Tab')
      editor.commands.undo()

      expect(render(editor)).toBe(outline`
        a
          b
          c
          d
      `)
    })

    it('INV-01: outdent preserves every nodeId', () => {
      editor = makeEditor(outline`
        a
          b
          c
            c1
          d
      `)
      const before = ids(editor)
      place(editor, 'c')
      press(editor, 'Shift-Tab')

      expect(ids(editor).sort()).toEqual(before.sort())
    })
  })

  // -------------------------------------------------------------- ENT: Enter

  describe('ENT — Enter', () => {
    it('ENT-01: at end of a childless bullet, creates the next sibling', () => {
      editor = makeEditor(outline`
        a
        b
      `)
      place(editor, 'a')
      press(editor, 'Enter')

      expect(render(editor)).toBe(outline`
        a
        ${EMPTY}
        b
      `)
      expect(caretOffset(editor)).toBe(0)
    })

    it('ENT-02: at end of a bullet with expanded children, creates the first child', () => {
      editor = makeEditor(outline`
        a
          a1
          a2
      `)
      place(editor, 'a')
      press(editor, 'Enter')

      expect(render(editor)).toBe(outline`
        a
          ${EMPTY}
          a1
          a2
      `)
    })

    it('ENT-03: at end of a bullet with collapsed children, creates the next sibling', () => {
      editor = makeEditor(outline`
        > a
          a1
        b
      `)
      place(editor, 'a')
      press(editor, 'Enter')

      expect(render(editor)).toBe(outline`
        > a
          a1
        ${EMPTY}
        b
      `)
    })

    it('ENT-04: at offset 0 of a non-empty bullet, inserts an empty bullet above', () => {
      editor = makeEditor(outline`
        a
          a1
        b
      `)
      place(editor, 'a', 0)
      press(editor, 'Enter')

      expect(render(editor)).toBe(outline`
        ${EMPTY}
        a
          a1
        b
      `)
      expect(caretBulletId(editor)).toBe('a')
      expect(caretOffset(editor)).toBe(0)
    })

    it('ENT-05: mid-text splits, and children stay with the original bullet', () => {
      editor = makeEditor(outline`
        alpha
          a1
        b
      `)
      place(editor, 'alpha', 2)
      press(editor, 'Enter')

      expect(render(editor)).toBe(outline`
        al
          a1
        pha
        b
      `)
      expect(caretOffset(editor)).toBe(0)
    })

    it('ENT-06: an empty childless bullet still creates a sibling', () => {
      editor = makeEditor(outline`
        a
        ${EMPTY}
      `)
      place(editor, EMPTY)
      press(editor, 'Enter')

      expect(collectBullets(editor.state.doc)).toHaveLength(3)
      expect(collectBullets(editor.state.doc).every((entry) => entry.ancestorIds.length === 0)).toBe(true)
    })

    it('ENT-07: a bullet created by Enter is plain and gets a fresh id', () => {
      editor = makeEditor(outline`
        a
      `)
      place(editor, 'a')
      press(editor, 'Enter')

      const created = collectBullets(editor.state.doc).find((entry) => entry.id !== 'a')
      expect(created).toBeDefined()
      expect(created!.id).not.toBe('a')
      expect(created!.bulletKind).toBe('bullet')
      expect(created!.completed).toBe(false)
      expect(created!.systemRole).toBeNull()
      expect(created!.node.attrs.collapsed).toBe(false)
      expect(created!.node.attrs.nodeType).toBe('user')
    })

    it('ENT-09: Enter over a text selection replaces it before splitting', () => {
      editor = makeEditor(outline`
        alphabet
      `)
      const entry = bullet(editor, 'alphabet')
      editor.commands.setTextSelection({ from: entry.pos + 2 + 2, to: entry.pos + 2 + 5 })
      press(editor, 'Enter')

      expect(render(editor)).toBe(outline`
        al
        et
      `)
    })
  })

  // ---------------------------------------------------------- BSP: Backspace

  describe('BSP — Backspace', () => {
    it('BSP-01: deletes an empty childless bullet and moves the caret above it', () => {
      editor = makeEditor(outline`
        a
        ${EMPTY}
        b
      `)
      place(editor, EMPTY, 0)
      press(editor, 'Backspace')

      expect(render(editor)).toBe(outline`
        a
        b
      `)
      expect(caretBulletId(editor)).toBe('a')
      expect(caretOffset(editor)).toBe(1)
    })

    it('BSP-01: the caret lands on the previous VISIBLE bullet, not the previous sibling', () => {
      editor = makeEditor(outline`
        a
          a1
            deep
        ${EMPTY}
      `)
      place(editor, EMPTY, 0)
      press(editor, 'Backspace')

      expect(caretBulletId(editor)).toBe('deep')
      expect(caretOffset(editor)).toBe(4)
    })

    it('BSP-01: a collapsed branch is skipped when finding the previous visible bullet', () => {
      editor = makeEditor(outline`
        > a
          a1
        ${EMPTY}
      `)
      place(editor, EMPTY, 0)
      press(editor, 'Backspace')

      expect(caretBulletId(editor)).toBe('a')
    })

    it('BSP-01: an empty first child is deleted, not outdented', () => {
      editor = makeEditor(outline`
        People
          Bojan
            ${EMPTY}
          Danica
      `)
      place(editor, EMPTY, 0)
      press(editor, 'Backspace')

      expect(render(editor)).toBe(outline`
        People
          Bojan
          Danica
      `)
      expect(caretBulletId(editor)).toBe('Bojan')
      expect(caretOffset(editor)).toBe(5)
      expect(bullet(editor, 'Bojan').node.childCount).toBe(1)
    })

    it('BSP-01: an empty first child with a following sibling is deleted, not outdented', () => {
      editor = makeEditor(outline`
        n1
          n2
            ${EMPTY}
            n3
      `)
      place(editor, EMPTY, 0)
      press(editor, 'Backspace')

      expect(render(editor)).toBe(outline`
        n1
          n2
            n3
      `)
      expect(caretBulletId(editor)).toBe('n2')
      expect(caretOffset(editor)).toBe(2)
    })

    it('BSP-01: an empty middle child is deleted without disturbing its siblings', () => {
      editor = makeEditor(outline`
        People
          Bojan
            first
            ${EMPTY}
            last
          Danica
      `)
      place(editor, EMPTY, 0)
      press(editor, 'Backspace')

      expect(render(editor)).toBe(outline`
        People
          Bojan
            first
            last
          Danica
      `)
      expect(caretBulletId(editor)).toBe('first')
    })

    it('BSP-02: an empty bullet with children is not deleted', () => {
      editor = makeEditor(outline`
        a
        ${EMPTY}
          child
      `)
      place(editor, EMPTY, 0)
      press(editor, 'Backspace')

      expect(render(editor)).toBe(outline`
        a
        ${EMPTY}
          child
      `)
    })

    it('BSP-03: merges a childless bullet into the previous visible childless bullet', () => {
      editor = makeEditor(outline`
        alpha
        bravo
      `)
      place(editor, 'bravo', 0)
      press(editor, 'Backspace')

      expect(render(editor)).toBe(outline`
        alphabravo
      `)
      expect(caretOffset(editor)).toBe(5)
    })

    it('BSP-04: a bullet with children never merges upward', () => {
      editor = makeEditor(outline`
        alpha
        bravo
          b1
      `)
      place(editor, 'bravo', 0)
      press(editor, 'Backspace')

      expect(render(editor)).toBe(outline`
        alpha
        bravo
          b1
      `)
    })

    it('BSP-05: at offset 0 of the first bullet, nothing happens', () => {
      editor = makeEditor(outline`
        alpha
        bravo
      `)
      place(editor, 'alpha', 0)
      press(editor, 'Backspace')

      expect(render(editor)).toBe(outline`
        alpha
        bravo
      `)
    })

    it('BSP-06: the last remaining bullet is never deleted', () => {
      editor = makeEditor(outline`
        ${EMPTY}
      `)
      place(editor, EMPTY, 0)
      press(editor, 'Backspace')

      expect(collectBullets(editor.state.doc)).toHaveLength(1)
      expect(editor.state.doc.firstChild?.type.name).toBe('bulletList')
    })

    it('BSP-08: Backspace over a text selection deletes only the selection', () => {
      editor = makeEditor(outline`
        alphabet
        b
      `)
      const entry = bullet(editor, 'alphabet')
      editor.commands.setTextSelection({ from: entry.pos + 2, to: entry.pos + 2 + 5 })
      press(editor, 'Backspace')

      expect(render(editor)).toBe(outline`
        bet
        b
      `)
    })
  })

  // ------------------------------------------------- MOV: Alt-Arrow movement

  describe('MOV — move up / down (Alt+Arrow)', () => {
    it('MOV-01: swaps with the previous sibling, depth unchanged', () => {
      editor = makeEditor(outline`
        a
        b
        c
      `)
      place(editor, 'c')
      press(editor, 'Alt-ArrowUp')

      expect(render(editor)).toBe(outline`
        a
        c
        b
      `)
    })

    it('MOV-01: swaps with the following sibling, depth unchanged', () => {
      editor = makeEditor(outline`
        a
        b
        c
      `)
      place(editor, 'a')
      press(editor, 'Alt-ArrowDown')

      expect(render(editor)).toBe(outline`
        b
        a
        c
      `)
    })

    it('MOV-02: moving up past an expanded sibling does not descend into it', () => {
      editor = makeEditor(outline`
        a
          a1
          a2
        b
      `)
      place(editor, 'b')
      press(editor, 'Alt-ArrowUp')

      expect(render(editor)).toBe(outline`
        b
        a
          a1
          a2
      `)
    })

    it('MOV-03: the first child moves up to sit immediately before its parent', () => {
      editor = makeEditor(outline`
        z
        a
          b
          c
      `)
      place(editor, 'b')
      press(editor, 'Alt-ArrowUp')

      expect(render(editor)).toBe(outline`
        z
        b
        a
          c
      `)
    })

    it('MOV-04: the last child moves down to sit immediately after its parent', () => {
      editor = makeEditor(outline`
        a
          b
          c
        z
      `)
      place(editor, 'c')
      press(editor, 'Alt-ArrowDown')

      expect(render(editor)).toBe(outline`
        a
          b
        c
        z
      `)
    })

    it('MOV-05: the first top-level bullet cannot move up', () => {
      editor = makeEditor(outline`
        a
        b
      `)
      place(editor, 'a')
      press(editor, 'Alt-ArrowUp')

      expect(render(editor)).toBe(outline`
        a
        b
      `)
    })

    it('MOV-05: the last top-level bullet cannot move down', () => {
      editor = makeEditor(outline`
        a
        b
      `)
      place(editor, 'b')
      press(editor, 'Alt-ArrowDown')

      expect(render(editor)).toBe(outline`
        a
        b
      `)
    })

    it('MOV-06: the moved branch travels intact with its collapse state', () => {
      editor = makeEditor(outline`
        a
        > b
          b1
      `)
      place(editor, 'b')
      press(editor, 'Alt-ArrowUp')

      expect(render(editor)).toBe(outline`
        > b
          b1
        a
      `)
    })

    it('MOV-07: the caret stays in the moved bullet at the same offset', () => {
      editor = makeEditor(outline`
        a
        bravo
      `)
      place(editor, 'bravo', 3)
      press(editor, 'Alt-ArrowUp')

      expect(caretBulletId(editor)).toBe('bravo')
      expect(caretOffset(editor)).toBe(3)
    })
  })

  // --------------------------------------------------------- DRP: drag/drop

  describe('DRP — drag and drop', () => {
    it('DRP-01: "before" inserts as the target\'s preceding sibling at its depth', () => {
      editor = makeEditor(outline`
        a
          a1
        b
      `)
      drop(editor, 'b', 'a1', 'before')

      expect(render(editor)).toBe(outline`
        a
          b
          a1
      `)
    })

    it('DRP-01: "after" inserts as the target\'s following sibling at its depth', () => {
      editor = makeEditor(outline`
        a
          a1
        b
      `)
      drop(editor, 'b', 'a1', 'after')

      expect(render(editor)).toBe(outline`
        a
          a1
          b
      `)
    })

    it('DRP-02: "inside" appends as the target\'s LAST child', () => {
      editor = makeEditor(outline`
        a
          a1
          a2
        b
      `)
      drop(editor, 'b', 'a', 'inside')

      expect(render(editor)).toBe(outline`
        a
          a1
          a2
          b
      `)
    })

    it('DRP-03: dropping onto a descendant is rejected', () => {
      editor = makeEditor(outline`
        a
          a1
            a1x
      `)
      expect(drop(editor, 'a', 'a1x', 'inside')).toBe(false)
      expect(render(editor)).toBe(outline`
        a
          a1
            a1x
      `)
    })

    it('DRP-04: dropping onto itself is a no-op', () => {
      editor = makeEditor(outline`
        a
        b
      `)
      expect(drop(editor, 'a', 'a', 'inside')).toBe(false)
      expect(render(editor)).toBe(outline`
        a
        b
      `)
    })

    it('DRP-05: an "inside" drop expands a collapsed target', () => {
      editor = makeEditor(outline`
        > a
          a1
        b
      `)
      drop(editor, 'b', 'a', 'inside')

      expect(render(editor)).toBe(outline`
        a
          a1
          b
      `)
    })

    it('DRP-06: the source\'s emptied parent loses its child list', () => {
      editor = makeEditor(outline`
        a
          a1
        b
      `)
      drop(editor, 'a1', 'b', 'after')

      expect(render(editor)).toBe(outline`
        a
        b
        a1
      `)
      expect(bullet(editor, 'a').node.childCount).toBe(1)
    })

    it('DRP-07: the dragged branch keeps its ids and collapse state', () => {
      editor = makeEditor(outline`
        a
        b
          > b1
            b1x
      `)
      const before = ids(editor)
      drop(editor, 'b', 'a', 'inside')

      expect(ids(editor).sort()).toEqual(before.sort())
      expect(bullet(editor, 'b1').node.attrs.collapsed).toBe(true)
      expect(render(editor)).toBe(outline`
        a
          b
            > b1
              b1x
      `)
    })

    it('INV-04: a drop is a single undo step', () => {
      editor = makeEditor(outline`
        a
          a1
        b
      `)
      drop(editor, 'b', 'a1', 'before')
      editor.commands.undo()

      expect(render(editor)).toBe(outline`
        a
          a1
        b
      `)
    })
  })

  // ----------------------------------------------------- cross-cutting INV

  describe('INV — invariants across operations', () => {
    it('INV-02: no empty bulletList survives a sequence of structural edits', () => {
      editor = makeEditor(outline`
        a
          a1
        b
          b1
      `)
      place(editor, 'a1')
      press(editor, 'Shift-Tab')
      place(editor, 'b1')
      press(editor, 'Shift-Tab')

      let empties = 0
      editor.state.doc.descendants((node) => {
        if (node.type.name === 'bulletList' && node.childCount === 0) empties += 1
      })
      expect(empties).toBe(0)
    })

    it('INV-06: notes, todo state, and completion travel with a moved bullet', () => {
      editor = makeEditor(outline`
        a
        b
      `)
      const target = bullet(editor, 'b')
      editor.view.dispatch(editor.state.tr.setNodeMarkup(target.pos, undefined, {
        ...target.node.attrs,
        bulletKind: 'todo',
        completed: true,
      }))
      place(editor, 'b')
      press(editor, 'Tab')

      const moved = bullet(editor, 'b')
      expect(moved.ancestorIds).toEqual(['a'])
      expect(moved.bulletKind).toBe('todo')
      expect(moved.completed).toBe(true)
    })

    it('INV-09: a rejected operation leaves the document untouched', () => {
      editor = makeEditor(outline`
        a
          a1
      `)
      const before = editor.state.doc.toJSON()
      place(editor, 'a1')
      press(editor, 'Tab')

      expect(editor.state.doc.toJSON()).toEqual(before)
    })
  })
})
