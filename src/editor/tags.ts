import { Extension } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { EditorState } from '@tiptap/pm/state'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

export const OUTLINE_TAG_EVENT = 'outline:tag-click'

const tagPluginKey = new PluginKey('outlineTags')
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

function clickedTag(event: MouseEvent): string | null {
  const target = event.target instanceof Element
    ? event.target.closest<HTMLElement>('.outline-tag')
    : null
  return target?.dataset.tag ?? null
}

export const TagDecorations = Extension.create({
  name: 'tagDecorations',

  addProseMirrorPlugins() {
    return [new Plugin({
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
