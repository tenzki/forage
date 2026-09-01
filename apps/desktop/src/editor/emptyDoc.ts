import { newNodeId, type JsonValue } from '../types/tree'
import { repairSystemNodes } from '@forage/document'

type PmJson = {
  type: string
  attrs?: Record<string, JsonValue>
  content?: PmJson[]
  text?: string
  marks?: JsonValue[]
}

function blankItem(nextId: () => string): PmJson {
  return {
    type: 'listItem',
    attrs: {
      nodeId: nextId(),
      nodeType: 'user',
      collapsed: false,
      bulletKind: 'bullet',
      completed: false,
    },
    content: [{ type: 'paragraph' }],
  }
}

function noteInlineContent(node: PmJson): PmJson[] {
  if (node.type === 'text' || node.type === 'hardBreak') return [structuredClone(node)]
  const inline: PmJson[] = []
  for (const child of node.content ?? []) inline.push(...noteInlineContent(child))
  return inline
}

function mergeItemNotes(item: PmJson): void {
  if (item.type !== 'listItem') return
  const children = item.content ?? []
  const title = children.find((child) => child.type === 'paragraph') ?? { type: 'paragraph' }
  const noteSources = children.filter((child) => child !== title && child.type !== 'bulletList')
  const lists = children.filter((child) => child.type === 'bulletList')
  const normalized: PmJson[] = [title]
  if (noteSources.length > 0) {
    const mergedContent: PmJson[] = []
    for (const note of noteSources) {
      const content = noteInlineContent(note)
      if (content.length === 0) continue
      if (mergedContent.length > 0) mergedContent.push({ type: 'hardBreak' })
      mergedContent.push(...content)
    }
    if (mergedContent.length > 0) normalized.push({ type: 'bulletNote', content: mergedContent })
  }
  if (lists.length > 0) {
    normalized.push({
      type: 'bulletList',
      content: lists.flatMap((list) => list.content ?? []),
    })
  }
  item.content = normalized
  for (const child of item.content ?? []) {
    if (child.type !== 'bulletList') continue
    for (const nested of child.content ?? []) mergeItemNotes(nested)
  }
}

function wrapBlock(block: PmJson, nextId: () => string): PmJson | null {
  if (block.type === 'paragraph') {
    if (!block.content?.length) return null
    const item = blankItem(nextId)
    item.content = [block]
    return item
  }
  if (block.type === 'bulletNote') {
    if (!block.content?.length) return null
    const item = blankItem(nextId)
    item.content = [{ type: 'paragraph' }, block]
    return item
  }
  return null
}

/** Keep persisted and freshly edited documents inside the outliner's root-list invariant. */
export function normalizeOutlinerDoc(doc: JsonValue, nextId: () => string = newNodeId): JsonValue {
  const value = structuredClone(doc) as PmJson
  const items: PmJson[] = []
  for (const block of value.content ?? []) {
    if (block.type === 'bulletList') {
      for (const child of block.content ?? []) {
        if (child.type === 'listItem') mergeItemNotes(child)
        if (child.type === 'listItem' || child.type === 'generatedImageItem') items.push(child)
      }
    } else if (block.type === 'generatedImageItem') {
      items.push(block)
    } else {
      const wrapped = wrapBlock(block, nextId)
      if (wrapped) items.push(wrapped)
    }
  }
  const editable = items.length === 0 ? blankItem(nextId) : null
  const normalized = {
    type: 'doc',
    content: [{ type: 'bulletList', content: editable ? [editable] : items }],
  }
  const repaired = repairSystemNodes(normalized as Record<string, unknown>, nextId).doc as PmJson
  if (editable) {
    const rootItems = repaired.content?.find((node) => node.type === 'bulletList')?.content
    const editableIndex = rootItems?.findIndex((node) => node.attrs?.nodeId === editable.attrs?.nodeId) ?? -1
    if (rootItems && editableIndex >= 0) rootItems.push(...rootItems.splice(editableIndex, 1))
  }
  return repaired as JsonValue
}

/** A fresh outline with canonical system roots and one ordinary editable bullet. */
export const EMPTY_DOC: JsonValue = normalizeOutlinerDoc({ type: 'doc' })
