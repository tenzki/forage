import { Mark, mergeAttributes, type Editor } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Fragment } from '@tiptap/pm/model'
import type { EditorState } from '@tiptap/pm/state'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { newNodeId } from '../types/tree'
import { collectBullets, type BulletEntry } from './outlineModel'

export const OUTLINE_INTERNAL_LINK_EVENT = 'outline:internal-link'

const internalLinkPluginKey = new PluginKey('outlineInternalLinks')

export interface ActiveInternalLink {
  query: string
  from: number
  to: number
}

export interface BacklinkEntry {
  source: BulletEntry
  label: string
}

export function activeInternalLinkAtSelection(state: EditorState): ActiveInternalLink | null {
  const { $from, empty } = state.selection
  if (!empty || !$from.parent.isTextblock) return null
  const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, '\ufffc')
  const match = /\[\[([^\]\n]*)$/.exec(textBefore)
  if (!match) return null
  return {
    query: match[1],
    from: $from.pos - match[0].length,
    to: $from.pos,
  }
}

function linkedTargetIds(doc: ProseMirrorNode): Set<string> {
  const ids = new Set<string>()
  doc.descendants((node) => {
    if (node.type.name === 'listItem' && node.attrs.nodeId) ids.add(node.attrs.nodeId)
  })
  return ids
}

function internalLinkDecorations(doc: ProseMirrorNode): DecorationSet {
  const targets = linkedTargetIds(doc)
  const decorations: Decoration[] = []
  doc.descendants((node, pos) => {
    if (!node.isText) return
    const link = node.marks.find((mark) => mark.type.name === 'internalLink')
    if (!link || targets.has(link.attrs.targetId)) return
    decorations.push(Decoration.inline(pos, pos + node.nodeSize, {
      class: 'internal-link-broken',
      title: 'Linked item no longer exists',
    }))
  })
  return DecorationSet.create(doc, decorations)
}

export function insertInternalLink(
  editor: Editor,
  range: Pick<ActiveInternalLink, 'from' | 'to'>,
  targetId: string,
  label: string,
): boolean {
  const title = label.trim() || 'Untitled'
  const mark = editor.schema.marks.internalLink?.create({ targetId })
  if (!mark) return false
  const content = Fragment.fromArray([
    editor.schema.text(title, [mark]),
    editor.schema.text(' '),
  ])
  const transaction = editor.state.tr.replaceWith(range.from, range.to, content)
  transaction.setSelection(TextSelection.create(transaction.doc, range.from + title.length + 1))
  editor.view.dispatch(transaction.scrollIntoView())
  editor.view.focus()
  return true
}

export function createAndInsertInternalLink(
  editor: Editor,
  range: Pick<ActiveInternalLink, 'from' | 'to'>,
  label: string,
): string | null {
  const title = label.trim()
  if (!title) return null
  const targetId = newNodeId()
  const mark = editor.schema.marks.internalLink?.create({ targetId })
  if (!mark) return null
  const replacement = Fragment.fromArray([
    editor.schema.text(title, [mark]),
    editor.schema.text(' '),
  ])
  const transaction = editor.state.tr.replaceWith(range.from, range.to, replacement)
  let rootInsertPos: number | null = null
  transaction.doc.forEach((node, offset) => {
    if (rootInsertPos === null && node.type.name === 'bulletList') {
      rootInsertPos = offset + 1 + node.content.size
    }
  })
  if (rootInsertPos === null) return null
  const paragraph = editor.schema.nodes.paragraph.create(null, editor.schema.text(title))
  const item = editor.schema.nodes.listItem.create({ nodeId: targetId }, paragraph)
  transaction.insert(rootInsertPos, item)
  transaction.setSelection(TextSelection.create(transaction.doc, range.from + title.length + 1))
  editor.view.dispatch(transaction.scrollIntoView())
  editor.view.focus()
  return targetId
}

export function soleInternalLinkTarget(entry: BulletEntry): string | null {
  if (entry.node.childCount !== 1 || entry.bulletKind !== 'bullet') return null
  const targetIds = new Set<string>()
  let hasOwnText = false
  entry.node.firstChild?.descendants((node) => {
    if (!node.isText || !node.text?.trim()) return
    const link = node.marks.find((mark) => mark.type.name === 'internalLink')
    if (link?.attrs.targetId) targetIds.add(link.attrs.targetId)
    else hasOwnText = true
  })
  return !hasOwnText && targetIds.size === 1 ? [...targetIds][0] : null
}

export function collectBacklinks(doc: ProseMirrorNode, targetId: string): BacklinkEntry[] {
  return collectBullets(doc).flatMap((source) => {
    let linked = false
    source.node.descendants((node) => {
      if (node.type.name === 'listItem') return false
      if (linked || !node.isText) return
      linked = node.marks.some((mark) => (
        mark.type.name === 'internalLink' && mark.attrs.targetId === targetId
      ))
    })
    return linked ? [{ source, label: source.text.trim() || 'Untitled' }] : []
  })
}

export const InternalLink = Mark.create({
  name: 'internalLink',
  priority: 1_100,
  inclusive: false,

  addAttributes() {
    return {
      targetId: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-internal-node-id'),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'a[data-internal-node-id]' }]
  },

  renderHTML({ HTMLAttributes }) {
    const attributes = { ...HTMLAttributes }
    const targetId = String(attributes.targetId ?? '')
    delete attributes.targetId
    return ['a', mergeAttributes(attributes, {
      class: 'internal-link',
      'data-internal-node-id': targetId,
      href: `#node=${encodeURIComponent(targetId)}`,
    }), 0]
  },

  addProseMirrorPlugins() {
    return [new Plugin({
      key: internalLinkPluginKey,
      state: {
        init: (_, state) => internalLinkDecorations(state.doc),
        apply: (transaction, previous) => transaction.docChanged
          ? internalLinkDecorations(transaction.doc)
          : previous.map(transaction.mapping, transaction.doc),
      },
      props: {
        decorations: (state) => internalLinkPluginKey.getState(state),
        handleDOMEvents: {
          click: (view, event) => {
            const target = event.target instanceof Element
              ? event.target.closest<HTMLElement>('a[data-internal-node-id]')
              : null
            const targetId = target?.dataset.internalNodeId
            if (!targetId) return false
            event.preventDefault()
            if (!linkedTargetIds(view.state.doc).has(targetId)) return true
            window.dispatchEvent(new CustomEvent(OUTLINE_INTERNAL_LINK_EVENT, {
              detail: { targetId },
            }))
            return true
          },
        },
      },
    })]
  },
})
