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
import { StableBulletAttributes } from '@forage/document'
import {
  SYSTEM_NODE_TRASH_META,
  preservesProtectedSystemNodes,
  SYSTEM_TITLE_UPDATE_META,
  validateSystemNodeAction,
} from './systemNodeGuards'

const idPluginKey = new PluginKey('bulletNodeIds')

export const BulletAttributes = StableBulletAttributes.extend({
  name: 'bulletAttributes',
  // Assign a stable nodeId to any listItem that lacks one (new bullets from Enter,
  // pasted content, or agent-inserted nodes). Runs as an appendTransaction so the
  // ids land in the same history step as the edit that created them.
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: idPluginKey,
        filterTransaction: (transaction, state) => {
          if (!transaction.docChanged || transaction.getMeta('forageRemote') === true) return true
          return preservesProtectedSystemNodes(
            state.doc,
            transaction.doc,
            transaction.getMeta(SYSTEM_TITLE_UPDATE_META) as string | null | undefined,
            transaction.getMeta(SYSTEM_NODE_TRASH_META) as string | null | undefined,
          )
        },
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
    if (collectBullets(state.doc).some((entry) => entry.systemRole !== null)) return true
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

function getEmptySystemChild(editor: Editor) {
  const { state } = editor
  if (!state.selection.empty) return null
  const entries = collectBullets(state.doc)
  const childId = currentBulletId(editor)
  const child = entries.find((entry) => entry.id === childId)
  const parentId = child?.ancestorIds[child.ancestorIds.length - 1]
  const parent = entries.find((entry) => entry.id === parentId)
  if (
    !child
    || !parent?.systemRole
    || child.text
    || child.noteText
    || child.node.childCount !== 1
  ) return null

  return { child, parent }
}

function removeEmptySystemChild(editor: Editor): boolean {
  const { state, view } = editor
  const { $from } = state.selection
  if (
    $from.parent.type !== state.schema.nodes.paragraph
    || $from.parentOffset !== 0
  ) return false

  const context = getEmptySystemChild(editor)
  if (!context) return false
  const { child, parent } = context

  const childList = state.doc.nodeAt(child.parentListPos)
  const childIsOnlyListItem = childList?.type === state.schema.nodes.bulletList
    && childList.childCount === 1
    && childList.firstChild === child.node
  const deleteFrom = childIsOnlyListItem
    ? child.parentListPos
    : child.pos
  const deleteTo = deleteFrom === child.parentListPos
    ? deleteFrom + childList!.nodeSize
    : child.pos + child.node.nodeSize
  const tr = state.tr.delete(deleteFrom, deleteTo)
  const nextParent = collectBullets(tr.doc).find((entry) => entry.id === parent.id)
  if (!nextParent) return false
  tr.setSelection(TextSelection.create(
    tr.doc,
    nextParent.pos + 2 + (nextParent.node.firstChild?.content.size ?? 0),
  ))
  view.dispatch(tr.scrollIntoView())
  return true
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
  if (nestedListOffset < 0) {
    if (!listItem.attrs.systemRole) return false
    const insertPos = $from.before(itemDepth) + listItem.nodeSize - 1
    const paragraph = state.schema.nodes.paragraph.create()
    const childItem = state.schema.nodes.listItem.create({
      nodeId: newNodeId(),
      nodeType: 'user',
      collapsed: false,
      bulletKind: 'bullet',
      completed: false,
      systemRole: null,
      dailyDate: null,
    }, paragraph)
    const childList = state.schema.nodes.bulletList.create(null, childItem)
    const tr = state.tr.insert(insertPos, childList)
    tr.setSelection(TextSelection.create(tr.doc, insertPos + 3))
    view.dispatch(tr.scrollIntoView())
    return true
  }

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
      Backspace: () => removeEmptySystemChild(this.editor) || preserveEmptyOutline(this.editor),
      Delete: () => preserveEmptyOutline(this.editor),
      Enter: () => {
        if (getEmptySystemChild(this.editor)) return true
        return insertBulletAtParentEnd(this.editor)
      },
      Tab: () => {
        const nodeId = currentBulletId(this.editor)
        if (nodeId && !validateSystemNodeAction(this.editor.state.doc, 'move', nodeId).allowed) return true
        this.editor.commands.sinkListItem('listItem')
        return true
      },
      'Shift-Tab': () => {
        const nodeId = currentBulletId(this.editor)
        if (nodeId && !validateSystemNodeAction(this.editor.state.doc, 'move', nodeId).allowed) return true
        this.editor.commands.liftListItem('listItem')
        return true
      },
      'Alt-ArrowUp': () => moveCurrentBullet(this.editor, -1),
      'Alt-ArrowDown': () => moveCurrentBullet(this.editor, 1),
      'Mod-Enter': () => toggleCurrentBulletCompleted(this.editor),
    }
  },
})
