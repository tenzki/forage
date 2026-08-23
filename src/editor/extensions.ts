// Editor extensions for the single-document outliner.
//
// Two small extensions on top of StarterKit (listItem, paragraph, marks, and
// native undo/redo history) plus the custom outline bullet list:
//
//   - BulletAttributes: adds stable `nodeId` + `nodeType` attrs to every
//     listItem, and auto-assigns a nodeId to any new listItem. This lets the
//     agent target a bullet and lets us style AI bullets (EDIT-04).
//   - OutlinerKeymap: Tab / Shift-Tab to nest / un-nest, Workflowy-style.

import { Extension, type Editor } from '@tiptap/core'
import { Fragment, Slice } from '@tiptap/pm/model'
import { AllSelection, Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { newNodeId } from '../types/tree'
import { collectBullets, currentBulletId, moveCurrentBullet, toggleCurrentBulletCompleted } from './outlineModel'

const idPluginKey = new PluginKey('bulletNodeIds')

export const BulletAttributes = Extension.create({
  name: 'bulletAttributes',

  addGlobalAttributes() {
    return [
      {
        types: ['listItem'],
        attributes: {
          nodeId: {
            default: null,
            parseHTML: (el) => el.getAttribute('data-node-id'),
            renderHTML: (attrs) =>
              attrs.nodeId ? { 'data-node-id': attrs.nodeId } : {},
          },
          nodeType: {
            default: 'user',
            parseHTML: (el) => el.getAttribute('data-node-type') ?? 'user',
            renderHTML: (attrs) => ({ 'data-node-type': attrs.nodeType ?? 'user' }),
          },
          collapsed: {
            default: false,
            parseHTML: (el) => el.getAttribute('data-collapsed') === 'true',
            renderHTML: (attrs) =>
              attrs.collapsed ? { 'data-collapsed': 'true' } : {},
          },
          bulletKind: {
            default: 'bullet',
            parseHTML: (el) => el.getAttribute('data-bullet-kind') === 'todo' ? 'todo' : 'bullet',
            renderHTML: (attrs) => attrs.bulletKind === 'todo'
              ? { 'data-bullet-kind': 'todo' }
              : {},
          },
          completed: {
            default: false,
            parseHTML: (el) => el.getAttribute('data-completed') === 'true',
            renderHTML: (attrs) => attrs.completed
              ? { 'data-completed': 'true' }
              : {},
          },
        },
      },
    ]
  },

  // Assign a stable nodeId to any listItem that lacks one (new bullets from Enter,
  // pasted content, or agent-inserted nodes). Runs as an appendTransaction so the
  // ids land in the same history step as the edit that created them.
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: idPluginKey,
        appendTransaction: (_transactions, _oldState, newState) => {
          const tr = newState.tr
          let modified = false
          const seen = new Set<string>()
          newState.doc.descendants((node, pos) => {
            if (node.type.name !== 'listItem') return
            const id = node.attrs.nodeId
            if (!id || seen.has(id)) {
              tr.setNodeMarkup(pos, undefined, {
                ...node.attrs,
                nodeId: newNodeId(),
              })
              modified = true
            } else {
              seen.add(id)
            }
          })
          return modified ? tr : null
        },
      }),
    ]
  },
})

function preserveEmptyOutline(editor: Editor): boolean {
  const { state, view } = editor
  const coversDocument = state.selection.from <= 1
    && state.selection.to >= state.doc.content.size - 1
  if (state.selection instanceof AllSelection || coversDocument) {
    const paragraph = state.schema.nodes.paragraph.create()
    const item = state.schema.nodes.listItem.create({
      nodeId: newNodeId(),
      nodeType: 'user',
      collapsed: false,
      bulletKind: 'bullet',
      completed: false,
    }, paragraph)
    const list = state.schema.nodes.bulletList.create(null, item)
    const replacement = new Slice(Fragment.from(list), 0, 0)
    const tr = state.tr.replace(0, state.doc.content.size, replacement)
    if (tr.doc.childCount > 1 && tr.doc.firstChild) {
      tr.delete(tr.doc.firstChild.nodeSize, tr.doc.content.size)
    }
    tr.setSelection(TextSelection.create(tr.doc, 3))
    view.dispatch(tr.scrollIntoView())
    return true
  }

  if (state.selection.$from.parent.type.name === 'bulletNote') return false
  const bullets = collectBullets(state.doc)
  const onlyBullet = bullets.length === 1 ? bullets[0] : null
  return Boolean(
    state.selection.empty
    && onlyBullet
    && currentBulletId(editor) === onlyBullet.id
    && !onlyBullet.text
    && !onlyBullet.noteText,
  )
}

function insertBulletAtParentEnd(editor: Editor): boolean {
  const { state, view } = editor
  const { $from } = state.selection
  if (!state.selection.empty || $from.parent.type !== state.schema.nodes.paragraph) return false
  if ($from.parentOffset !== $from.parent.content.size) return false

  const itemDepth = $from.depth - 1
  if (itemDepth < 1 || $from.node(itemDepth).type !== state.schema.nodes.listItem) return false
  if ($from.index(itemDepth) !== 0) return false

  const listItem = $from.node(itemDepth)
  let nestedListOffset = -1
  let childOffset = 0
  listItem.forEach((child) => {
    if (nestedListOffset < 0 && child.type === state.schema.nodes.bulletList) {
      nestedListOffset = childOffset
    }
    childOffset += child.nodeSize
  })
  if (nestedListOffset < 0) return false

  const nestedListPos = $from.before(itemDepth) + 1 + nestedListOffset
  const insertPos = listItem.attrs.collapsed
    ? $from.after(itemDepth)
    : nestedListPos + 1
  const paragraph = state.schema.nodes.paragraph.create()
  const childItem = state.schema.nodes.listItem.create(null, paragraph)
  const tr = state.tr.insert(insertPos, childItem)
  tr.setSelection(TextSelection.create(tr.doc, insertPos + 2))
  view.dispatch(tr.scrollIntoView())
  return true
}

export const OutlinerKeymap = Extension.create({
  name: 'outlinerKeymap',
  priority: 1_000,

  addKeyboardShortcuts() {
    return {
      Backspace: () => preserveEmptyOutline(this.editor),
      Delete: () => preserveEmptyOutline(this.editor),
      Enter: () => insertBulletAtParentEnd(this.editor),
      Tab: () => {
        this.editor.commands.sinkListItem('listItem')
        return true
      },
      'Shift-Tab': () => {
        this.editor.commands.liftListItem('listItem')
        return true
      },
      'Alt-ArrowUp': () => moveCurrentBullet(this.editor, -1),
      'Alt-ArrowDown': () => moveCurrentBullet(this.editor, 1),
      'Mod-Enter': () => toggleCurrentBulletCompleted(this.editor),
    }
  },
})
