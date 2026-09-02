// Editor extensions for the single-document outliner.
//
// Two small extensions on top of StarterKit's editing primitives plus the
// custom outline list schema:
//
//   - BulletAttributes: adds stable `nodeId` + `nodeType` attrs to every
//     listItem, and auto-assigns a nodeId to any new listItem. This lets the
//     agent target a bullet and lets us style AI bullets (EDIT-04).
//   - OutlinerKeymap: Tab / Shift-Tab to nest / un-nest, Workflowy-style.

import { Extension, type Editor } from '@tiptap/core'
import { Fragment, Slice, type Node as ProseMirrorNode } from '@tiptap/pm/model'
import { AllSelection, Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { newNodeId } from '../types/tree'
import {
  collectBullets,
  currentBulletId,
  moveCurrentBullet,
  toggleCurrentBulletCompleted,
  type BulletEntry,
} from './outlineModel'
import { StableBulletAttributes } from '@forage/document'
import {
  SYSTEM_NODE_TRASH_META,
  preservesProtectedSystemNodes,
  SYSTEM_TITLE_UPDATE_META,
  validateSystemNodeAction,
} from './systemNodeGuards'

const idPluginKey = new PluginKey('bulletNodeIds')
const mutationLockedEditors = new WeakSet<Editor>()

export function setEditorMutationLocked(editor: Editor, locked: boolean): void {
  if (locked) mutationLockedEditors.add(editor)
  else mutationLockedEditors.delete(editor)
}

export const BulletAttributes = StableBulletAttributes.extend({
  name: 'bulletAttributes',
  // Assign a stable nodeId to any listItem that lacks one (new bullets from Enter,
  // pasted content, or agent-inserted nodes). Runs as an appendTransaction so the
  // ids land in the same history step as the edit that created them.
  addProseMirrorPlugins() {
    const editor = this.editor
    return [
      new Plugin({
        key: idPluginKey,
        filterTransaction: (transaction, state) => {
          if (mutationLockedEditors.has(editor) && transaction.getMeta('forageRemote') !== true) return false
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

function bulletHasChildren(node: ProseMirrorNode): boolean {
  for (let index = 0; index < node.childCount; index += 1) {
    if (node.child(index).type.name === 'bulletList') return true
  }
  return false
}

/**
 * The bullet rendered directly above `entries[index]`: the previous sibling's
 * deepest visible descendant, else the previous sibling, else the parent.
 * Bullets inside a collapsed branch are skipped — they are not on screen.
 */
function previousVisibleBullet(entries: BulletEntry[], index: number): BulletEntry | null {
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const candidate = entries[cursor]
    const hidden = candidate.ancestorIds.some((id) => byId.get(id)?.node.attrs.collapsed)
    if (!hidden) return candidate
  }
  return null
}

/** Delete the bullet, taking its wrapping bulletList with it when it is the only child. */
function bulletRemovalRange(editor: Editor, entry: BulletEntry): { from: number; to: number } {
  const list = editor.state.doc.nodeAt(entry.parentListPos)
  const isOnlyChild = list?.type === editor.state.schema.nodes.bulletList && list.childCount === 1
  return isOnlyChild
    ? { from: entry.parentListPos, to: entry.parentListPos + list.nodeSize }
    : { from: entry.pos, to: entry.pos + entry.node.nodeSize }
}

/**
 * Backspace at the very start of a bullet (BSP-01..BSP-05 in
 * docs/outline-structure-rules.md). Backspace removes or merges a bullet; it
 * never changes a bullet's depth, which is what ProseMirror's default list
 * joinBackward does. Returning true swallows the key so the default cannot run.
 */
function handleStructuralBackspace(editor: Editor): boolean {
  const { state, view } = editor
  const { $from, empty } = state.selection
  // BSP-08: a text selection is deleted by the default handler, never a bullet.
  if (!empty) return false
  if ($from.parent.type !== state.schema.nodes.paragraph || $from.parentOffset !== 0) return false

  const entries = collectBullets(state.doc)
  const currentId = currentBulletId(editor)
  const index = entries.findIndex((entry) => entry.id === currentId)
  const entry = entries[index]
  if (!entry) return false
  // BSP-07 / BSP-02 / BSP-04: never delete a system node, a bullet with
  // children, or a bullet whose note would silently disappear with it.
  if (entry.systemRole || entry.noteText || bulletHasChildren(entry.node)) return true

  const previous = previousVisibleBullet(entries, index)
  // BSP-05: nothing above to merge into.
  if (!previous) return true

  const transaction = state.tr
  const range = bulletRemovalRange(editor, entry)
  if (entry.text) {
    // BSP-03: merge upward only into a plain, childless bullet. A parent, a
    // collapsed branch, or a system title keeps its shape instead.
    if (previous.systemRole || previous.noteText || bulletHasChildren(previous.node)) return true
    const joinAt = previous.pos + 2 + (previous.node.firstChild?.content.size ?? 0)
    transaction.delete(range.from, range.to)
    transaction.insert(joinAt, entry.node.firstChild?.content ?? Fragment.empty)
    transaction.setSelection(TextSelection.create(transaction.doc, joinAt))
  } else {
    // BSP-01: delete the empty bullet and land at the end of the bullet above.
    transaction.delete(range.from, range.to)
    const landing = collectBullets(transaction.doc).find((item) => item.id === previous.id)
    if (!landing) return true
    transaction.setSelection(TextSelection.create(
      transaction.doc,
      landing.pos + 2 + (landing.node.firstChild?.content.size ?? 0),
    ))
  }
  view.dispatch(transaction.scrollIntoView())
  return true
}

function freshBullet(editor: Editor, paragraph = editor.state.schema.nodes.paragraph.create()) {
  return editor.state.schema.nodes.listItem.create({
    nodeId: newNodeId(),
    nodeType: 'user',
    collapsed: false,
    bulletKind: 'bullet',
    completed: false,
    systemRole: null,
    dailyDate: null,
  }, paragraph)
}

function handleTitleEnter(editor: Editor): boolean {
  const { state, view } = editor
  const { $from } = state.selection
  if (!state.selection.empty || $from.parent.type !== state.schema.nodes.paragraph) return false

  const itemDepth = $from.depth - 1
  if (itemDepth < 1 || $from.node(itemDepth).type !== state.schema.nodes.listItem) return false
  if ($from.index(itemDepth) !== 0) return false

  const listItem = $from.node(itemDepth)
  const itemPos = $from.before(itemDepth)
  if ($from.parentOffset === 0 && $from.parent.content.size > 0) {
    const item = freshBullet(editor)
    const tr = state.tr.insert(itemPos, item)
    tr.setSelection(TextSelection.create(tr.doc, itemPos + 2))
    view.dispatch(tr.scrollIntoView())
    return true
  }
  if ($from.parentOffset < $from.parent.content.size) {
    const suffix = $from.parent.content.cut($from.parentOffset)
    const paragraph = state.schema.nodes.paragraph.create($from.parent.attrs, suffix)
    const item = freshBullet(editor, paragraph)
    const deleteTo = $from.start() + $from.parent.content.size
    const removedSize = deleteTo - $from.pos
    const insertPos = $from.after(itemDepth) - removedSize
    const tr = state.tr.delete($from.pos, deleteTo).insert(insertPos, item)
    tr.setSelection(TextSelection.create(tr.doc, insertPos + 2))
    view.dispatch(tr.scrollIntoView())
    return true
  }

  let nestedListOffset = -1
  let childOffset = 0
  listItem.forEach((child) => {
    if (nestedListOffset < 0 && child.type === state.schema.nodes.bulletList) {
      nestedListOffset = childOffset
    }
    childOffset += child.nodeSize
  })
  if (nestedListOffset < 0) {
    if (!listItem.attrs.systemRole) {
      const insertPos = $from.after(itemDepth)
      const tr = state.tr.insert(insertPos, freshBullet(editor))
      tr.setSelection(TextSelection.create(tr.doc, insertPos + 2))
      view.dispatch(tr.scrollIntoView())
      return true
    }
    const insertPos = itemPos + listItem.nodeSize - 1
    const childList = state.schema.nodes.bulletList.create(null, freshBullet(editor))
    const tr = state.tr
    if (listItem.attrs.collapsed) {
      tr.setNodeMarkup(itemPos, undefined, { ...listItem.attrs, collapsed: false })
    }
    tr.insert(insertPos, childList)
    tr.setSelection(TextSelection.create(tr.doc, insertPos + 3))
    view.dispatch(tr.scrollIntoView())
    return true
  }

  const nestedListPos = $from.before(itemDepth) + 1 + nestedListOffset
  const insertPos = listItem.attrs.collapsed
    ? $from.after(itemDepth)
    : nestedListPos + 1
  const tr = state.tr.insert(insertPos, freshBullet(editor))
  tr.setSelection(TextSelection.create(tr.doc, insertPos + 2))
  view.dispatch(tr.scrollIntoView())
  return true
}

export const OutlinerKeymap = Extension.create({
  name: 'outlinerKeymap',
  priority: 1_000,

  addKeyboardShortcuts() {
    return {
      Backspace: () => removeEmptySystemChild(this.editor)
        || preserveEmptyOutline(this.editor)
        || handleStructuralBackspace(this.editor),
      Delete: () => preserveEmptyOutline(this.editor),
      Enter: () => {
        if (getEmptySystemChild(this.editor)) return true
        return handleTitleEnter(this.editor)
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
