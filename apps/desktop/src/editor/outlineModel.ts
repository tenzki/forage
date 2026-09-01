import type { Editor } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { TextSelection } from '@tiptap/pm/state'
import { newNodeId, type BulletKind, type JsonValue, type TrashEntry } from '../types/tree'
import { findSystemNode, isCanonicalDailyDate, type SystemRole } from '@forage/document'
import {
  SYSTEM_MAINTENANCE_META,
  SYSTEM_NODE_TRASH_META,
  SYSTEM_TITLE_UPDATE_META,
  validateSystemNodeAction,
} from './systemNodeGuards'
import { DOMAIN_MUTATION_META, type EditorDomainMutation } from './eventCapture'

export interface BulletEntry {
  id: string
  text: string
  noteText: string
  pos: number
  node: ProseMirrorNode
  parentListPos: number
  siblingIndex: number
  ancestorIds: string[]
  bulletKind: BulletKind
  completed: boolean
  systemRole: SystemRole | null
  dailyDate: string | null
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
    let noteText = ''
    for (let index = 0; index < node.childCount; index += 1) {
      const child = node.child(index)
      if (child.type.name === 'bulletNote') {
        noteText = child.textBetween(0, child.content.size, '\n', '\n')
      }
    }
    entries.push({
      id: node.attrs.nodeId,
      text: node.firstChild?.textContent ?? '',
      noteText,
      pos,
      node,
      parentListPos: resolved.before(resolved.depth),
      siblingIndex: resolved.index(resolved.depth),
      ancestorIds,
      bulletKind: node.attrs.bulletKind === 'todo' ? 'todo' : 'bullet',
      completed: Boolean(node.attrs.completed),
      systemRole: node.attrs.systemRole ?? null,
      dailyDate: node.attrs.dailyDate ?? null,
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

function dispatchDocument(
  editor: Editor,
  json: PmJson,
  selectedId?: string,
  history = true,
  options: {
    allowedSystemNodeTrashId?: string
    domainMutation?: EditorDomainMutation
  } = {},
): void {
  const next = editor.schema.nodeFromJSON(json)
  const transaction = editor.state.tr.replaceWith(0, editor.state.doc.content.size, next.content)
  if (!history) transaction.setMeta('addToHistory', false)
  if (options.allowedSystemNodeTrashId) {
    transaction.setMeta(SYSTEM_NODE_TRASH_META, options.allowedSystemNodeTrashId)
  }
  if (options.domainMutation) transaction.setMeta(DOMAIN_MUTATION_META, options.domainMutation)
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
  if (!validateSystemNodeAction(editor.state.doc, 'move', sourceId, targetId).allowed) return false
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

export function setBulletKind(editor: Editor, nodeId: string, bulletKind: BulletKind): boolean {
  const entry = findBullet(editor.state.doc, nodeId)
  if (!entry || !validateSystemNodeAction(editor.state.doc, 'convert', nodeId).allowed) return false
  editor.view.dispatch(editor.state.tr.setNodeMarkup(entry.pos, undefined, {
    ...entry.node.attrs,
    bulletKind,
    completed: bulletKind === 'todo' ? Boolean(entry.node.attrs.completed) : false,
  }))
  return true
}

export function setTodoCompleted(editor: Editor, nodeId: string, completed: boolean): boolean {
  const entry = findBullet(editor.state.doc, nodeId)
  if (!entry || !validateSystemNodeAction(editor.state.doc, 'convert', nodeId).allowed) return false
  editor.view.dispatch(editor.state.tr.setNodeMarkup(entry.pos, undefined, {
    ...entry.node.attrs,
    bulletKind: 'todo',
    completed,
  }))
  return true
}

export function toggleBulletCompleted(editor: Editor, nodeId: string): boolean {
  const entry = findBullet(editor.state.doc, nodeId)
  if (!entry || entry.bulletKind !== 'todo'
    || !validateSystemNodeAction(editor.state.doc, 'convert', nodeId).allowed) return false
  editor.view.dispatch(editor.state.tr.setNodeMarkup(entry.pos, undefined, {
    ...entry.node.attrs,
    completed: !entry.completed,
  }))
  return true
}

export function toggleCurrentBulletCompleted(editor: Editor): boolean {
  const nodeId = currentBulletId(editor)
  if (!nodeId) return false
  const entry = findBullet(editor.state.doc, nodeId)
  if (!entry) return false
  if (entry.bulletKind === 'bullet') return setTodoCompleted(editor, nodeId, false)
  if (!entry.completed) return setTodoCompleted(editor, nodeId, true)
  return setBulletKind(editor, nodeId, 'bullet')
}

const COMPLETION_FILTERS = new Set(['is:todo', 'is:complete', 'is:completed', 'is:open'])

export function normalizeSearchText(value: string): string {
  return value.normalize('NFKD').replace(/\p{Mark}/gu, '').toLocaleLowerCase()
}

function inboundReferenceCounts(entries: BulletEntry[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const source of entries) {
    const targets = new Set<string>()
    source.node.descendants((node) => {
      if (node.type.name === 'listItem') return false
      if (!node.isText) return
      for (const mark of node.marks) {
        const targetId = mark.type.name === 'internalLink' ? mark.attrs.targetId : null
        if (typeof targetId === 'string' && targetId) targets.add(targetId)
      }
    })
    for (const targetId of targets) counts.set(targetId, (counts.get(targetId) ?? 0) + 1)
  }
  return counts
}

function searchProminence(entry: BulletEntry, referenceCounts: Map<string, number>): number {
  const referenceWeight = 4
  return (referenceCounts.get(entry.id) ?? 0) * referenceWeight - entry.ancestorIds.length
}

export function searchBullets(entries: BulletEntry[], query: string): BulletEntry[] {
  const tokens = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean)
  const filters = new Set(tokens.filter((token) => COMPLETION_FILTERS.has(token)))
  const terms = tokens
    .filter((token) => !COMPLETION_FILTERS.has(token))
    .map(normalizeSearchText)
  const referenceCounts = inboundReferenceCounts(entries)
  return entries
    .map((entry, documentIndex) => ({ entry, documentIndex }))
    .filter(({ entry }) => {
      if (filters.has('is:todo') && entry.bulletKind !== 'todo') return false
      if ((filters.has('is:complete') || filters.has('is:completed'))
        && (entry.bulletKind !== 'todo' || !entry.completed)) return false
      if (filters.has('is:open') && (entry.bulletKind !== 'todo' || entry.completed)) return false
      const searchableText = normalizeSearchText(`${entry.text}\n${entry.noteText}`)
      return terms.every((term) => searchableText.includes(term))
    })
    .sort((left, right) => (
      searchProminence(right.entry, referenceCounts)
      - searchProminence(left.entry, referenceCounts)
      || left.documentIndex - right.documentIndex
    ))
    .map(({ entry }) => entry)
}

export function searchText(query: string): string {
  return query.trim().split(/\s+/u)
    .filter((token) => !COMPLETION_FILTERS.has(token.toLocaleLowerCase()))
    .join(' ')
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
  if (!validateSystemNodeAction(editor.state.doc, 'duplicate', nodeId).allowed) return false
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
  if (!validateSystemNodeAction(editor.state.doc, 'trash', nodeId).allowed) return null
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
  dispatchDocument(editor, doc, undefined, false, {
    allowedSystemNodeTrashId: nodeId,
    domainMutation: { type: 'trash.entry_added', entry: trash },
  })
  return trash
}

export function restoreBullet(editor: Editor, trash: TrashEntry): boolean {
  const doc = cloneDocument(editor)
  const node = structuredClone(asPmJson(trash.node))
  const nodeId = String(node.attrs?.nodeId ?? '')
  if (!nodeId || findJsonItem(doc, nodeId)) return false
  let dailyNotesParentId: string | null = null
  if (node.attrs?.systemRole === 'daily-note') {
    const dailyDate = node.attrs.dailyDate
    if (!isCanonicalDailyDate(dailyDate)) return false
    if (collectBullets(editor.state.doc).some((entry) => (
      entry.systemRole === 'daily-note' && entry.dailyDate === dailyDate
    ))) return false
    dailyNotesParentId = findSystemNode(editor.state.doc, 'daily-notes')?.id ?? null
    if (!dailyNotesParentId) return false
  }
  let list = rootList(doc)
  const parentId = dailyNotesParentId ?? trash.originalParentId
  if (parentId) {
    const parent = findJsonItem(doc, parentId)
    if (dailyNotesParentId && !parent) return false
    if (parent) list = childList(parent.node, true)
  }
  if (!list) return false
  if (list === rootList(doc) && list.content?.length === 1 && isBlankItem(list.content[0])) {
    list.content = []
  }
  insertAt(list, node, trash.originalIndex)
  dispatchDocument(editor, doc, nodeId, false, {
    domainMutation: { type: 'trash.entry_restored', entryId: trash.id },
  })
  return true
}

export function updateBulletText(
  editor: Editor,
  nodeId: string,
  text: string,
  options: { allowProtectedTitle?: boolean } = {},
): boolean {
  const entry = findBullet(editor.state.doc, nodeId)
  const paragraph = entry?.node.firstChild
  if (!entry || !paragraph) return false
  const from = entry.pos + 2
  const transaction = editor.state.tr
  if (options.allowProtectedTitle) {
    transaction.setMeta(SYSTEM_TITLE_UPDATE_META, nodeId)
    transaction.setMeta(SYSTEM_MAINTENANCE_META, true)
    transaction.setMeta('addToHistory', false)
  }
  if (text) transaction.replaceWith(from, from + paragraph.content.size, editor.schema.text(text))
  else transaction.delete(from, from + paragraph.content.size)
  editor.view.dispatch(transaction)
  return true
}

/** Focus an existing first direct child, or create one when a container is empty. */
export function focusFirstChildOrCreate(editor: Editor, parentId: string, nextId: () => string): string | null {
  const parent = findBullet(editor.state.doc, parentId)
  if (!parent) return null
  const childPath = [...parent.ancestorIds, parent.id]
  const existing = collectBullets(editor.state.doc).find((entry) => (
    entry.ancestorIds.length === childPath.length
    && entry.ancestorIds.every((id, index) => id === childPath[index])
  ))
  if (existing && !parent.node.attrs.collapsed) {
    selectBullet(editor, existing.id)
    return existing.id
  }

  const childId = existing?.id ?? nextId()
  const transaction = editor.state.tr
  transaction.setMeta(SYSTEM_MAINTENANCE_META, true)
  transaction.setMeta('addToHistory', false)
  if (parent.node.attrs.collapsed) {
    transaction.setNodeMarkup(parent.pos, undefined, { ...parent.node.attrs, collapsed: false })
  }
  if (!existing) {
    const paragraph = editor.schema.nodes.paragraph.create()
    const child = editor.schema.nodes.listItem.create({
      nodeId: childId,
      nodeType: 'user',
      collapsed: false,
      bulletKind: 'bullet',
      completed: false,
      systemRole: null,
      dailyDate: null,
    }, paragraph)
    let nestedListOffset = -1
    let childOffset = 0
    parent.node.forEach((node) => {
      if (nestedListOffset < 0 && node.type === editor.schema.nodes.bulletList) nestedListOffset = childOffset
      childOffset += node.nodeSize
    })
    if (nestedListOffset < 0) {
      transaction.insert(
        parent.pos + parent.node.nodeSize - 1,
        editor.schema.nodes.bulletList.create(null, child),
      )
    } else {
      transaction.insert(parent.pos + 2 + nestedListOffset, child)
    }
  }
  editor.view.dispatch(transaction.scrollIntoView())
  selectBullet(editor, childId)
  return childId
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
