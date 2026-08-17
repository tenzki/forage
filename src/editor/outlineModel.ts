import type { Editor } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { TextSelection } from '@tiptap/pm/state'
import { newNodeId, type JsonValue, type TrashEntry } from '../types/tree'

export interface BulletEntry {
  id: string
  text: string
  pos: number
  node: ProseMirrorNode
  parentListPos: number
  siblingIndex: number
  ancestorIds: string[]
}

export type MovePlacement = 'before' | 'after' | 'inside'

type PmJson = {
  type: string
  attrs?: Record<string, unknown>
  content?: PmJson[]
  text?: string
  marks?: unknown[]
}

interface JsonItemLocation {
  node: PmJson
  list: PmJson
  index: number
}

export function collectBullets(doc: ProseMirrorNode): BulletEntry[] {
  const entries: BulletEntry[] = []
  doc.descendants((node, pos) => {
    if (node.type.name !== 'listItem' || !node.attrs.nodeId) return
    const resolved = doc.resolve(pos)
    const ancestorIds: string[] = []
    for (let depth = 1; depth <= resolved.depth; depth += 1) {
      const ancestor = resolved.node(depth)
      if (ancestor.type.name === 'listItem' && ancestor.attrs.nodeId) {
        ancestorIds.push(ancestor.attrs.nodeId)
      }
    }
    entries.push({
      id: node.attrs.nodeId,
      text: node.firstChild?.textContent ?? '',
      pos,
      node,
      parentListPos: resolved.before(resolved.depth),
      siblingIndex: resolved.index(resolved.depth),
      ancestorIds,
    })
  })
  return entries
}

export function findBullet(doc: ProseMirrorNode, nodeId: string): BulletEntry | null {
  return collectBullets(doc).find((entry) => entry.id === nodeId) ?? null
}

export function currentBulletId(editor: Editor): string | null {
  const { $from } = editor.state.selection
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth)
    if (node.type.name === 'listItem') return node.attrs.nodeId ?? null
  }
  return null
}

function asPmJson(value: JsonValue): PmJson {
  return value as unknown as PmJson
}

function cloneDocument(editor: Editor): PmJson {
  return structuredClone(editor.state.doc.toJSON()) as PmJson
}

function findJsonItem(node: PmJson, nodeId: string): JsonItemLocation | null {
  if (node.type === 'bulletList') {
    const items = node.content ?? []
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]
      if (item.type === 'listItem' && item.attrs?.nodeId === nodeId) {
        return { node: item, list: node, index }
      }
      const nested = findJsonItem(item, nodeId)
      if (nested) return nested
    }
  } else {
    for (const child of node.content ?? []) {
      const nested = findJsonItem(child, nodeId)
      if (nested) return nested
    }
  }
  return null
}

function containsItem(node: PmJson, nodeId: string): boolean {
  if (node.type === 'listItem' && node.attrs?.nodeId === nodeId) return true
  return (node.content ?? []).some((child) => containsItem(child, nodeId))
}

function rootList(doc: PmJson): PmJson | null {
  return (doc.content ?? []).find((node) => node.type === 'bulletList') ?? null
}

function childList(item: PmJson, create: boolean): PmJson | null {
  const existing = (item.content ?? []).find((node) => node.type === 'bulletList')
  if (existing || !create) return existing ?? null
  const list: PmJson = { type: 'bulletList', content: [] }
  item.content = [...(item.content ?? []), list]
  return list
}

function insertAt(list: PmJson, item: PmJson, index: number): void {
  const content = list.content ?? []
  content.splice(Math.max(0, Math.min(index, content.length)), 0, item)
  list.content = content
}

function pruneEmptyNestedLists(node: PmJson): void {
  if (!node.content) return
  for (const child of node.content) pruneEmptyNestedLists(child)
  node.content = node.content.filter((child) => (
    child.type !== 'bulletList' || Boolean(child.content?.length)
  ))
}

function isBlankItem(node: PmJson): boolean {
  if (node.type !== 'listItem') return false
  const paragraph = node.content?.[0]
  return node.content?.length === 1 && paragraph?.type === 'paragraph' && !paragraph.content?.length
}

function dispatchDocument(editor: Editor, json: PmJson, selectedId?: string, history = true): void {
  const next = editor.schema.nodeFromJSON(json)
  const transaction = editor.state.tr.replaceWith(0, editor.state.doc.content.size, next.content)
  if (!history) transaction.setMeta('addToHistory', false)
  if (selectedId) {
    const moved = findBullet(transaction.doc, selectedId)
    if (moved) transaction.setSelection(TextSelection.near(transaction.doc.resolve(moved.pos + 2)))
  }
  editor.view.dispatch(transaction.scrollIntoView())
}

function placeItem(doc: PmJson, item: PmJson, targetId: string | null, placement: MovePlacement): boolean {
  if (!targetId) {
    const list = rootList(doc)
    if (!list) return false
    insertAt(list, item, list.content?.length ?? 0)
    return true
  }
  const target = findJsonItem(doc, targetId)
  if (!target) return false
  if (placement === 'inside') {
    const list = childList(target.node, true)
    if (!list) return false
    insertAt(list, item, list.content?.length ?? 0)
  } else {
    insertAt(target.list, item, target.index + (placement === 'after' ? 1 : 0))
  }
  return true
}

/** Move a complete branch anywhere in one history transaction. */
export function moveBulletTo(
  editor: Editor,
  sourceId: string,
  targetId: string | null,
  placement: MovePlacement = 'inside',
): boolean {
  if (sourceId === targetId) return false
  const doc = cloneDocument(editor)
  const source = findJsonItem(doc, sourceId)
  if (!source || (targetId && containsItem(source.node, targetId))) return false
  const [item] = (source.list.content ?? []).splice(source.index, 1)
  if (!item || !placeItem(doc, item, targetId, placement)) return false
  pruneEmptyNestedLists(doc)
  dispatchDocument(editor, doc, sourceId)
  return true
}

export function moveBulletById(editor: Editor, nodeId: string, direction: -1 | 1): boolean {
  const source = findBullet(editor.state.doc, nodeId)
  if (!source) return false
  const siblings = collectBullets(editor.state.doc).filter(
    (entry) => entry.parentListPos === source.parentListPos,
  )
  const target = siblings[source.siblingIndex + direction]
  if (!target) return false
  return moveBulletTo(editor, nodeId, target.id, direction < 0 ? 'before' : 'after')
}

export function moveCurrentBullet(editor: Editor, direction: -1 | 1): boolean {
  const id = currentBulletId(editor)
  return id ? moveBulletById(editor, id, direction) : false
}

export function reorderBullet(
  editor: Editor,
  sourceId: string,
  targetId: string,
  placement: MovePlacement | boolean,
): boolean {
  const normalized = typeof placement === 'boolean' ? (placement ? 'after' : 'before') : placement
  return moveBulletTo(editor, sourceId, targetId, normalized)
}

function refreshIds(node: PmJson): void {
  if (node.type === 'listItem') node.attrs = { ...node.attrs, nodeId: newNodeId() }
  for (const child of node.content ?? []) refreshIds(child)
}

export function duplicateBullet(editor: Editor, nodeId: string): boolean {
  const doc = cloneDocument(editor)
  const source = findJsonItem(doc, nodeId)
  if (!source) return false
  const copy = structuredClone(source.node) as PmJson
  refreshIds(copy)
  insertAt(source.list, copy, source.index + 1)
  dispatchDocument(editor, doc, String(copy.attrs?.nodeId ?? ''))
  return true
}

function blankItem(): PmJson {
  return {
    type: 'listItem',
    attrs: { nodeId: newNodeId(), nodeType: 'user', collapsed: false },
    content: [{ type: 'paragraph' }],
  }
}

/** Remove a branch without adding the operation to history; Trash is its recovery path. */
export function trashBullet(editor: Editor, nodeId: string): TrashEntry | null {
  const entry = findBullet(editor.state.doc, nodeId)
  const doc = cloneDocument(editor)
  const source = findJsonItem(doc, nodeId)
  if (!entry || !source) return null
  const [node] = (source.list.content ?? []).splice(source.index, 1)
  const root = rootList(doc)
  if (!node || !root) return null
  if (!(root.content?.length)) root.content = [blankItem()]
  pruneEmptyNestedLists(doc)
  const trash: TrashEntry = {
    id: newNodeId(),
    deletedAt: new Date().toISOString(),
    originalParentId: entry.ancestorIds[entry.ancestorIds.length - 1] ?? null,
    originalIndex: entry.siblingIndex,
    node: node as unknown as JsonValue,
  }
  dispatchDocument(editor, doc, undefined, false)
  return trash
}

export function restoreBullet(editor: Editor, trash: TrashEntry): boolean {
  const doc = cloneDocument(editor)
  const node = structuredClone(asPmJson(trash.node))
  const nodeId = String(node.attrs?.nodeId ?? '')
  if (!nodeId || findJsonItem(doc, nodeId)) return false
  let list = rootList(doc)
  if (trash.originalParentId) {
    const parent = findJsonItem(doc, trash.originalParentId)
    if (parent) list = childList(parent.node, true)
  }
  if (!list) return false
  if (list === rootList(doc) && list.content?.length === 1 && isBlankItem(list.content[0])) {
    list.content = []
  }
  insertAt(list, node, trash.originalIndex)
  dispatchDocument(editor, doc, nodeId, false)
  return true
}

export function updateBulletText(editor: Editor, nodeId: string, text: string): boolean {
  const entry = findBullet(editor.state.doc, nodeId)
  const paragraph = entry?.node.firstChild
  if (!entry || !paragraph) return false
  const from = entry.pos + 2
  const transaction = editor.state.tr
  if (text) transaction.replaceWith(from, from + paragraph.content.size, editor.schema.text(text))
  else transaction.delete(from, from + paragraph.content.size)
  editor.view.dispatch(transaction)
  return true
}

export function selectBullet(editor: Editor, nodeId: string): boolean {
  const entry = findBullet(editor.state.doc, nodeId)
  if (!entry) return false
  editor.commands.setTextSelection(entry.pos + 2)
  editor.commands.focus()
  return true
}

export function breadcrumbFor(doc: ProseMirrorNode, nodeId: string | null): BulletEntry[] {
  if (!nodeId) return []
  const entries = collectBullets(doc)
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const target = byId.get(nodeId)
  if (!target) return []
  return [...target.ancestorIds, target.id]
    .map((id) => byId.get(id))
    .filter((entry): entry is BulletEntry => Boolean(entry))
}
