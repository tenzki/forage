import { Extension, type Editor } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { EditorState, Transaction } from '@tiptap/pm/state'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { ReplaceStep } from '@tiptap/pm/transform'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

export const OUTLINE_TAG_EVENT = 'outline:tag-click'

const tagPluginKey = new PluginKey('outlineTags')
const tagTypingKey = new PluginKey<boolean>('outlineTagTyping')
const TAG_PATTERN = /(^|[^\p{L}\p{N}_\/#])#([\p{L}\p{N}_-]+)/gu
const ACTIVE_TAG_PATTERN = /(^|[^\p{L}\p{N}_\/#])#([\p{L}\p{N}_-]*)$/u

export interface ActiveTag {
  query: string
  from: number
  to: number
}

export function tagsInText(text: string): string[] {
  const tags: string[] = []
  for (const match of text.matchAll(TAG_PATTERN)) tags.push(match[2].toLocaleLowerCase())
  return tags
}

export interface TagMatch {
  tag: string
  /** Offset of the `#`. */
  from: number
  /** Offset just past the tag name. */
  to: number
}

export function tagMatchesInText(text: string): TagMatch[] {
  return [...text.matchAll(TAG_PATTERN)].map((match) => {
    const from = (match.index ?? 0) + match[1].length
    return { tag: match[2].toLocaleLowerCase(), from, to: from + match[2].length + 1 }
  })
}

export function collectTags(doc: ProseMirrorNode): string[] {
  const tags = new Set<string>()
  doc.descendants((node) => {
    if (node.type.name !== 'paragraph') return
    for (const tag of tagsInText(node.textContent)) tags.add(tag)
  })
  return [...tags].sort((left, right) => left.localeCompare(right))
}

export function activeTagAtSelection(state: EditorState): ActiveTag | null {
  const { $from, empty } = state.selection
  if (!empty || !$from.parent.isTextblock) return null
  const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, '\ufffc')
  const match = ACTIVE_TAG_PATTERN.exec(textBefore)
  if (!match) return null
  const tokenLength = match[2].length + 1
  return {
    query: match[2].toLocaleLowerCase(),
    from: $from.pos - tokenLength,
    to: $from.pos,
  }
}

function tagDecorations(doc: ProseMirrorNode): DecorationSet {
  const decorations: Decoration[] = []
  doc.descendants((node, pos) => {
    if (node.type.name !== 'paragraph') return
    for (const match of node.textContent.matchAll(TAG_PATTERN)) {
      const start = pos + 1 + (match.index ?? 0) + match[1].length
      const tag = match[2].toLocaleLowerCase()
      decorations.push(Decoration.inline(start, start + tag.length + 1, {
        class: 'outline-tag',
        'data-tag': tag,
        title: `Search #${tag}`,
      }))
    }
  })
  return DecorationSet.create(doc, decorations)
}

/**
 * Whether the tag before the caret is still being typed: text was inserted at
 * the caret inside it, and the caret has stayed in it since. Moving the caret
 * or finishing the tag ends it.
 */
function tagTyping(transaction: Transaction, typing: boolean, state: EditorState): boolean {
  if (!transaction.docChanged) return transaction.selectionSet ? false : typing
  if (!activeTagAtSelection(state)) return false
  if (typing) return true
  return transaction.steps.some((step, index) => step instanceof ReplaceStep
    && step.slice.size > 0
    && transaction.mapping.slice(index + 1).map(step.from + step.slice.size) === state.selection.from)
}

/** Backspace in or just after a finished tag removes the whole tag. */
function deleteTagAtCaret(editor: Editor): boolean {
  const { state } = editor
  const { $from, empty } = state.selection
  if (!empty || $from.parent.type.name !== 'paragraph' || tagTypingKey.getState(state)) return false
  // Every inline leaf counts as one character, so text offsets equal document offsets.
  const text = $from.parent.textBetween(0, $from.parent.content.size, undefined, '\ufffc')
  const offset = $from.parentOffset
  const tag = tagMatchesInText(text).find((match) => match.from < offset && offset <= match.to)
  if (!tag) return false
  // Take the space before a tag in mid-sentence along, so no double space remains.
  const from = /\s/.test(text[tag.to] ?? '') && /\s/.test(text[tag.from - 1] ?? '') ? tag.from - 1 : tag.from
  const start = $from.start()
  editor.view.dispatch(state.tr.delete(start + from, start + tag.to).scrollIntoView())
  return true
}

function clickedTag(event: MouseEvent): string | null {
  const target = event.target instanceof Element
    ? event.target.closest<HTMLElement>('.outline-tag')
    : null
  return target?.dataset.tag ?? null
}

export const TagDecorations = Extension.create({
  name: 'tagDecorations',

  addKeyboardShortcuts() {
    return {
      Backspace: () => deleteTagAtCaret(this.editor),
    }
  },

  addProseMirrorPlugins() {
    return [new Plugin<boolean>({
      key: tagTypingKey,
      state: {
        init: () => false,
        apply: (transaction, typing, _previous, state) => tagTyping(transaction, typing, state),
      },
    }), new Plugin({
      key: tagPluginKey,
      state: {
        init: (_, state) => tagDecorations(state.doc),
        apply: (transaction, previous) => transaction.docChanged
          ? tagDecorations(transaction.doc)
          : previous.map(transaction.mapping, transaction.doc),
      },
      props: {
        decorations: (state) => tagPluginKey.getState(state),
        handleDOMEvents: {
          click: (_view, event) => {
            const tag = clickedTag(event)
            if (!tag) return false
            event.preventDefault()
            window.dispatchEvent(new CustomEvent(OUTLINE_TAG_EVENT, {
              detail: { tag },
            }))
            return true
          },
        },
      },
    })]
  },
})
