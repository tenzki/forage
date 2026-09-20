// Bridges the Pi stream to the single TipTap document: resolve the command's
// local branch and explicit references, then insert an AI-styled child bullet under the current
// one, and stream text into it.
//
// Two rules shape this file:
//   - The agent emits one idea per line, so each line becomes its own bullet.
//     A single text node would collapse the newlines when rendered as HTML.
//   - Generation must never disturb the user. The insert does not move the
//     selection, and every streaming write uses addToHistory:false so the whole
//     generation collapses into the one undo step created by the insert.

import type { Editor } from '@tiptap/react'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { TextSelection } from '@tiptap/pm/state'
import { setAgentActivity } from '../editor/outlinerUi'
import { newNodeId } from '../types/tree'
import type { CodexAuthConfig } from './client'
import type { AgentDefinition } from './definitions'
import { resolveAgentContext } from './context'
import { generateWithPi, type PiOutlineNode } from './piGeneration'
import type { Skill } from './skills'
import type { CustomHttpToolConfig } from './tools'
import { buildOutlineSnapshot } from './outlineSnapshot'
import type { ActivityReporter } from './activity'
import { NativeAssetRepository } from '../persistence/assetStore'
import type { GeneratedImageReference } from '../editor/generatedImage'
import {
  parseStructuredResult,
  requireStructuredResultV1,
  type StructuredResult,
  type StructuredResultNode,
  type StructuredResultV2,
  type StructuredResultV2Node,
} from '@forage/agent-runtime'
import { clearStreamingText, showStreamingText, type StreamingTextRange } from '../editor/agentStreamingText'

function contextText(item: ProseMirrorNode): string {
  const title = item.firstChild?.textContent?.trim() ?? ''
  let note = ''
  item.forEach((child) => {
    if (child.type.name === 'bulletNote') note = child.textContent.trim()
  })
  return note ? `${title}\nNote: ${note}`.trim() : title
}

/** Text of the listItems enclosing the cursor, outer-to-inner. */
export function ancestorContext(editor: Editor): string[] {
  const { $from } = editor.state.selection
  const texts: string[] = []
  for (let d = 1; d <= $from.depth; d++) {
    const node = $from.node(d)
    if (node.type.name === 'listItem') {
      const text = contextText(node)
      if (text) texts.push(text)
    }
  }
  return texts
}

/** Text of direct siblings around the current bullet, in document order. */
export function siblingContext(editor: Editor): string[] {
  const { $from } = editor.state.selection
  for (let depth = $from.depth; depth > 0; depth--) {
    const current = $from.node(depth)
    if (current.type.name !== 'listItem' || depth < 1) continue
    const parentList = $from.node(depth - 1)
    const texts: string[] = []
    parentList.forEach((sibling) => {
      if (sibling === current) return
      const text = contextText(sibling)
      if (text) texts.push(text)
    })
    return texts
  }
  return []
}

/** Find the listItem enclosing the cursor; returns its position + node. */
function currentListItem(editor: Editor) {
  const { $from } = editor.state.selection
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === 'listItem') {
      return { depth: d, pos: $from.before(d), node: $from.node(d) }
    }
  }
  return null
}

export function currentListItemId(editor: Editor): string | null {
  const nodeId = currentListItem(editor)?.node.attrs.nodeId
  return typeof nodeId === 'string' ? nodeId : null
}

/** Replace the text of the bullet the cursor is in (used to set the prompt note). */
export function setCurrentBulletText(
  editor: Editor,
  text: string,
  moveCursorToEnd = false,
): void {
  const li = currentListItem(editor)
  if (!li) return
  const para = li.node.firstChild
  const paraStart = li.pos + 2
  const size = para?.content.size ?? 0
  const tr = editor.state.tr
  if (text.length) {
    tr.replaceWith(paraStart, paraStart + size, editor.schema.text(text))
  } else if (size > 0) {
    tr.delete(paraStart, paraStart + size)
  }
  if (moveCursorToEnd) {
    tr.setSelection(TextSelection.create(tr.doc, paraStart + text.length))
  }
  editor.view.dispatch(tr)
}

/** Remove only the slash-command prefix, retaining structured links in the prompt. */
export function removeCurrentSlashCommand(editor: Editor, label: string): void {
  const item = currentListItem(editor)
  if (!item) return
  const paragraph = item.node.firstChild
  const text = paragraph?.textContent ?? ''
  const prefix = `/${label}`
  if (!text.startsWith(prefix)) return
  let prefixLength = prefix.length
  while (/\s/.test(text[prefixLength] ?? '')) prefixLength += 1
  const paragraphStart = item.pos + 2
  const transaction = editor.state.tr.delete(paragraphStart, paragraphStart + prefixLength)
  editor.view.dispatch(transaction)
}

/**
 * Insert a bulletList holding one empty AI bullet under the current listItem.
 * Returns the nodeId of that bullet, which identifies the list for later writes.
 * The selection is left untouched so the user keeps typing where they were.
 */
export function insertAiChild(editor: Editor): string | null {
  const li = currentListItem(editor)
  if (!li) return null
  return insertAiChildAt(editor, li.pos, li.node)
}

export function insertAiChildUnder(editor: Editor, parentNodeId: string): string | null {
  let parent: { pos: number; node: ProseMirrorNode } | null = null
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== 'listItem' || node.attrs.nodeId !== parentNodeId) return
    parent = { pos, node }
    return false
  })
  if (!parent) return null
  const target = parent as { pos: number; node: ProseMirrorNode }
  return insertAiChildAt(editor, target.pos, target.node)
}

function insertAiChildAt(editor: Editor, parentPos: number, parentNode: ProseMirrorNode): string {
  const nodeId = newNodeId()
  // Position just inside the end of the current listItem (after its paragraph).
  const insertPos = parentPos + parentNode.nodeSize - 1
  editor
    .chain()
    .setMeta('forageOrigin', 'agent')
    .setMeta('forageChangeGroup', nodeId)
    .insertContentAt(
      insertPos,
      {
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            attrs: { nodeId, nodeType: 'ai' },
            content: [{ type: 'paragraph' }],
          },
        ],
      },
      { updateSelection: false },
    )
    .run()
  return nodeId
}

/** Locate the bulletList whose first child carries `rootNodeId`. */
function findAiList(
  editor: Editor,
  rootNodeId: string,
): { pos: number; node: ProseMirrorNode } | null {
  let found: { pos: number; node: ProseMirrorNode } | null = null
  editor.state.doc.descendants((node, pos) => {
    if (found) return false
    if (node.type.name !== 'bulletList') return undefined
    node.forEach((child) => {
      if (child.type.name === 'listItem' && child.attrs.nodeId === rootNodeId) {
        found = { pos, node }
      }
    })
    return undefined
  })
  return found
}

/** Remove failed generated output without adding cleanup to the undo history. */
export function removeAiList(editor: Editor, rootNodeId: string): void {
  const list = findAiList(editor, rootNodeId)
  if (!list) return
  const transaction = editor.state.tr.delete(list.pos, list.pos + list.node.nodeSize)
  transaction.setMeta('addToHistory', false)
  transaction.setMeta('forageOrigin', 'agent')
  transaction.setMeta('forageChangeGroup', rootNodeId)
  editor.view.dispatch(transaction)
}

/** Split streamed text into the lines that should become bullets. */
function toLines(text: string): string[] {
  // Models often separate ideas with blank lines. Empty list items create
  // orphan dots, so keep only visible outline content.
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  return lines.length ? lines : ['']
}

interface ParsedLink {
  end: number
  href: string
  label: string
}

function safeExternalHref(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? value : null
  } catch {
    return null
  }
}

function markdownLinkAt(text: string, start: number): ParsedLink | null {
  if (text[start] !== '[') return null
  const labelEnd = text.indexOf('](', start + 1)
  if (labelEnd <= start + 1) return null
  const destinationStart = labelEnd + 2
  let nestedParentheses = 0
  for (let index = destinationStart; index < text.length; index += 1) {
    const character = text[index]
    if (/\s/u.test(character)) return null
    if (character === '(') {
      nestedParentheses += 1
    } else if (character === ')' && nestedParentheses > 0) {
      nestedParentheses -= 1
    } else if (character === ')') {
      const destination = text.slice(destinationStart, index)
      const href = safeExternalHref(destination)
      return href ? {
        end: index + 1,
        href,
        label: text.slice(start + 1, labelEnd),
      } : null
    }
  }
  return null
}

function trimBareUrlEnd(value: string): number {
  let end = value.length
  while (end > 0) {
    const character = value[end - 1]
    if (/[.,!?;:]/u.test(character)) {
      end -= 1
      continue
    }
    const opening = character === ')' ? '(' : character === ']' ? '[' : character === '}' ? '{' : null
    if (opening) {
      const candidate = value.slice(0, end)
      const openings = [...candidate].filter((part) => part === opening).length
      const closings = [...candidate].filter((part) => part === character).length
      if (closings > openings) {
        end -= 1
        continue
      }
    }
    break
  }
  return end
}

function bareLinkAt(text: string, start: number): ParsedLink | null {
  if (!/^https?:\/\//iu.test(text.slice(start))) return null
  let rawEnd = start
  while (rawEnd < text.length && !/[\s<>"']/u.test(text[rawEnd])) rawEnd += 1
  const value = text.slice(start, rawEnd)
  const linkLength = trimBareUrlEnd(value)
  const href = safeExternalHref(value.slice(0, linkLength))
  return href ? { end: start + linkLength, href, label: href } : null
}

function aiInlineContent(editor: Editor, text: string): ProseMirrorNode[] {
  const { schema } = editor
  const linkType = schema.marks.link
  if (!text || !linkType) return text ? [schema.text(text)] : []
  const nodes: ProseMirrorNode[] = []
  let plainText = ''
  const flushPlainText = () => {
    if (!plainText) return
    nodes.push(schema.text(plainText))
    plainText = ''
  }

  for (let index = 0; index < text.length;) {
    const link = markdownLinkAt(text, index) ?? bareLinkAt(text, index)
    if (!link) {
      plainText += text[index]
      index += 1
      continue
    }
    flushPlainText()
    nodes.push(schema.text(link.label, [linkType.create({ href: link.href })]))
    index = link.end
  }
  flushPlainText()
  return nodes
}

/**
 * Materialise the agent's output so far as one AI bullet per line, replacing
 * whatever the previous delta wrote. Bullet ids are stable across deltas, and
 * the write is kept out of the undo history and away from the selection.
 */
export function writeAiText(
  editor: Editor,
  rootNodeId: string,
  text: string,
  previousText?: string,
): void {
  const list = findAiList(editor, rootNodeId)
  if (!list) return

  const { schema } = editor
  const existingIds: string[] = []
  list.node.forEach((child) => existingIds.push(child.attrs.nodeId))

  const items = toLines(text).map((line, i) =>
    schema.nodes.listItem.create(
      { nodeId: existingIds[i] ?? newNodeId(), nodeType: 'ai' },
      schema.nodes.paragraph.create(null, aiInlineContent(editor, line)),
    ),
  )
  replaceAiList(editor, list, items)
  if (previousText !== undefined) {
    showStreamingText(editor, streamingRanges(editor, rootNodeId, previousText))
  }
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length)
  let index = 0
  while (index < limit && left[index] === right[index]) index += 1
  return index
}

function streamingRanges(editor: Editor, rootNodeId: string, previousText: string): StreamingTextRange[] {
  const list = findAiList(editor, rootNodeId)
  if (!list) return []
  const previousLines = toLines(previousText)
  const ranges: StreamingTextRange[] = []
  list.node.forEach((child, offset, index) => {
    if (child.type.name !== 'listItem') return
    const paragraph = child.firstChild
    const currentText = paragraph?.textContent ?? ''
    const priorText = previousLines[index] ?? ''
    const startOffset = commonPrefixLength(currentText, priorText)
    if (startOffset >= currentText.length) return
    const paragraphStart = list.pos + 1 + offset + 2
    ranges.push({ from: paragraphStart + startOffset, to: paragraphStart + currentText.length })
  })
  return ranges
}

/** Replace the generated placeholder with validated nested outline nodes. */
export type StoredOutlineNode =
  | { text: string; children?: StoredOutlineNode[] }
  | { image: GeneratedImageReference }

export interface GeneratedAssetIngestor {
  ingestGeneratedImage: (value: unknown) => Promise<GeneratedImageReference>
}

export async function prepareAiOutline(
  nodes: PiOutlineNode[],
  assets: GeneratedAssetIngestor = new NativeAssetRepository(),
): Promise<StoredOutlineNode[]> {
  return Promise.all(nodes.map(async (node): Promise<StoredOutlineNode> => {
    if ('image' in node) return { image: await assets.ingestGeneratedImage(node.image) }
    return {
      text: node.text,
      ...(node.children?.length ? { children: await prepareAiOutline(node.children, assets) } : {}),
    }
  }))
}

export function writeAiOutline(
  editor: Editor,
  rootNodeId: string,
  nodes: StoredOutlineNode[],
): void {
  const list = findAiList(editor, rootNodeId)
  if (!list || !nodes.length) return
  const existingIds: string[] = []
  list.node.forEach((child) => existingIds.push(child.attrs.nodeId))
  let existingIndex = 0
  const items = nodes.flatMap((node) => {
    const nodeId = 'image' in node ? newNodeId() : existingIds[existingIndex++] ?? newNodeId()
    return createAiOutlineItem(editor, node, nodeId)
  })
  replaceAiList(editor, list, items)
}

function createAiOutlineItem(editor: Editor, node: StoredOutlineNode, nodeId: string): ProseMirrorNode[] {
  const { schema } = editor
  if ('image' in node) {
    if (!schema.nodes.generatedImageItem || !schema.nodes.generatedImage) return []
    const image = schema.nodes.generatedImage.create(node.image)
    return [schema.nodes.generatedImageItem.create(null, image)]
  }
  const content: ProseMirrorNode[] = [
    schema.nodes.paragraph.create(null, aiInlineContent(editor, node.text)),
  ]
  if (node.children?.length) {
    const children = node.children.flatMap((child) => createAiOutlineItem(editor, child, newNodeId()))
    if (children.length) content.push(schema.nodes.bulletList.create(null, children))
  }
  return [schema.nodes.listItem.create({ nodeId, nodeType: 'ai' }, content)]
}

/** Insert an agent result under its invocation bullet. Returns the new top-level bullet ids. */
export function commitStructuredAgentResult(
  editor: Editor,
  invocationNodeId: string,
  skillLabel: string,
  result: StructuredResult,
): string[] {
  const materializable = requireStructuredResultV1(result)
  let invocation: { pos: number; node: ProseMirrorNode } | null = null
  editor.state.doc.descendants((node, pos) => {
    if (invocation || node.type.name !== 'listItem' || node.attrs.nodeId !== invocationNodeId) return
    invocation = { pos, node }
    return false
  })
  if (!invocation) throw new Error('The skill invocation target is no longer available.')
  const target = invocation as { pos: number; node: ProseMirrorNode }
  const nodes = materializable.nodes.map(structuredToStored)
  const items = nodes.flatMap((node) => createAiOutlineItem(editor, node, newNodeId()))
  if (!items.length) throw new Error('The agent returned no outline nodes.')

  const paragraph = target.node.firstChild
  const text = paragraph?.textContent ?? ''
  const prefix = `/${skillLabel}`
  let prefixLength = text.startsWith(prefix) ? prefix.length : 0
  while (/\s/.test(text[prefixLength] ?? '')) prefixLength += 1
  const paragraphStart = target.pos + 2
  const originalInsertPosition = target.pos + target.node.nodeSize - 1
  const transaction = editor.state.tr
  if (prefixLength) transaction.delete(paragraphStart, paragraphStart + prefixLength)
  const insertPosition = transaction.mapping.map(originalInsertPosition, -1)
  transaction.insert(insertPosition, editor.schema.nodes.bulletList.create(null, items))
  transaction.setMeta('forageOrigin', 'agent')
  editor.view.dispatch(transaction)
  const nodeIds = items
    .map((item) => item.attrs.nodeId)
    .filter((nodeId): nodeId is string => typeof nodeId === 'string' && nodeId.length > 0)
  revealAgentResult(editor, nodeIds)
  return nodeIds
}

function extensionResultNodeId(runId: string, path: readonly number[]): string {
  return `extension-result-${runId}-${path.join('-')}`.slice(0, 128)
}

function extensionInlineContent(
  editor: Editor,
  node: StructuredResultV2Node,
): ProseMirrorNode[] {
  const mark = editor.schema.marks.internalLink
  if (!mark) throw new Error('The editor cannot materialize internal references.')
  const inline: ProseMirrorNode[] = []
  node.segments.forEach((segment) => {
    const text = segment.type === 'text' ? segment.text : segment.label
    const marks = segment.type === 'internal-reference'
      ? [mark.create({ targetId: segment.nodeId })]
      : undefined
    text.split('\n').forEach((line, index) => {
      if (index > 0) inline.push(editor.schema.nodes.hardBreak.create())
      if (line) inline.push(editor.schema.text(line, marks))
    })
  })
  return inline
}

function createExtensionResultItem(
  editor: Editor,
  node: StructuredResultV2Node,
  runId: string,
  path: readonly number[],
): ProseMirrorNode {
  const content: ProseMirrorNode[] = [
    editor.schema.nodes.paragraph.create(null, extensionInlineContent(editor, node)),
  ]
  if (node.children?.length) {
    content.push(editor.schema.nodes.bulletList.create(null, node.children.map((child, index) => (
      createExtensionResultItem(editor, child, runId, [...path, index])
    ))))
  }
  return editor.schema.nodes.listItem.create({
    nodeId: extensionResultNodeId(runId, path),
    nodeType: 'ai',
  }, content)
}

function findListItem(
  editor: Editor,
  nodeId: string,
): { pos: number; node: ProseMirrorNode } | null {
  let found: { pos: number; node: ProseMirrorNode } | null = null
  editor.state.doc.descendants((node, pos) => {
    if (found || node.type.name !== 'listItem' || node.attrs.nodeId !== nodeId) return
    found = { pos, node }
    return false
  })
  return found
}

function validatedExtensionResult(
  result: StructuredResult,
  admittedReferenceIds: Iterable<string>,
): StructuredResultV2 {
  const parsed = parseStructuredResult(result, { allowedReferenceIds: admittedReferenceIds })
  if (parsed.version !== 2) throw new Error('Extension skill output must use reference-aware structured results.')
  return parsed
}

/**
 * Materialize a complete generic extension result as ordinary list items in one
 * transaction. Deterministic run-scoped ids make recovery idempotent if the app
 * closes after the document event is persisted but before the retained run is
 * marked placed.
 */
export function insertExtensionSkillResult(
  editor: Editor,
  targetNodeId: string,
  runId: string,
  result: StructuredResult,
  admittedReferenceIds: Iterable<string>,
): string[] {
  const materializable = validatedExtensionResult(result, admittedReferenceIds)
  const rootNodeIds = materializable.nodes.map((_, index) => extensionResultNodeId(runId, [index]))
  const existing = rootNodeIds.filter((nodeId) => findListItem(editor, nodeId))
  if (existing.length === rootNodeIds.length) return rootNodeIds
  if (existing.length) throw new Error('The retained extension result is only partially present in the outline.')
  const target = findListItem(editor, targetNodeId)
  if (!target) throw new Error('The extension skill output target is no longer available.')
  const items = materializable.nodes.map((node, index) => createExtensionResultItem(editor, node, runId, [index]))
  const transaction = editor.state.tr
  transaction.insert(
    target.pos + target.node.nodeSize - 1,
    editor.schema.nodes.bulletList.create(null, items),
  )
  transaction.setMeta('forageOrigin', 'agent')
  transaction.setMeta('forageChangeGroup', runId)
  editor.view.dispatch(transaction)
  revealAgentResult(editor, rootNodeIds)
  return rootNodeIds
}

/** Place under the original invocation and remove only its slash-command prefix. */
export function commitExtensionSkillResult(
  editor: Editor,
  invocationNodeId: string,
  skillLabel: string,
  runId: string,
  result: StructuredResult,
  admittedReferenceIds: Iterable<string>,
): string[] {
  const materializable = validatedExtensionResult(result, admittedReferenceIds)
  const target = findListItem(editor, invocationNodeId)
  if (!target) throw new Error('The extension skill invocation target is no longer available.')
  const rootNodeIds = materializable.nodes.map((_, index) => extensionResultNodeId(runId, [index]))
  const items = materializable.nodes.map((node, index) => createExtensionResultItem(editor, node, runId, [index]))
  const paragraph = target.node.firstChild
  const text = paragraph?.textContent ?? ''
  const prefix = `/${skillLabel}`
  let prefixLength = text.startsWith(prefix) ? prefix.length : 0
  while (/\s/.test(text[prefixLength] ?? '')) prefixLength += 1
  const transaction = editor.state.tr
  if (prefixLength) transaction.delete(target.pos + 2, target.pos + 2 + prefixLength)
  const insertPosition = transaction.mapping.map(target.pos + target.node.nodeSize - 1, -1)
  transaction.insert(insertPosition, editor.schema.nodes.bulletList.create(null, items))
  transaction.setMeta('forageOrigin', 'agent')
  transaction.setMeta('forageChangeGroup', runId)
  editor.view.dispatch(transaction)
  revealAgentResult(editor, rootNodeIds)
  return rootNodeIds
}

export function commitStructuredAgentResultInto(
  editor: Editor,
  invocationNodeId: string,
  rootNodeId: string,
  skillLabel: string,
  result: StructuredResult,
): string[] {
  const materializable = requireStructuredResultV1(result)
  let invocation: { pos: number; node: ProseMirrorNode } | null = null
  editor.state.doc.descendants((node, pos) => {
    if (invocation || node.type.name !== 'listItem' || node.attrs.nodeId !== invocationNodeId) return
    invocation = { pos, node }
    return false
  })
  const list = findAiList(editor, rootNodeId)
  if (!invocation || !list) throw new Error('The live agent output is no longer available.')
  const target = invocation as { pos: number; node: ProseMirrorNode }
  const existingIds: string[] = []
  list.node.forEach((child) => {
    if (child.type.name === 'listItem' && typeof child.attrs.nodeId === 'string') existingIds.push(child.attrs.nodeId)
  })
  let existingIndex = 0
  const items = materializable.nodes.flatMap((node) => {
    const nodeId = node.type === 'image' ? newNodeId() : existingIds[existingIndex++] ?? newNodeId()
    return createAiOutlineItem(editor, structuredToStored(node), nodeId)
  })
  if (!items.length) throw new Error('The agent returned no outline nodes.')

  const paragraph = target.node.firstChild
  const text = paragraph?.textContent ?? ''
  const prefix = `/${skillLabel}`
  let prefixLength = text.startsWith(prefix) ? prefix.length : 0
  while (/\s/.test(text[prefixLength] ?? '')) prefixLength += 1
  const transaction = editor.state.tr
  if (prefixLength) transaction.delete(target.pos + 2, target.pos + 2 + prefixLength)
  const mappedFrom = transaction.mapping.map(list.pos, -1)
  const mappedTo = transaction.mapping.map(list.pos + list.node.nodeSize, 1)
  transaction.replaceWith(mappedFrom, mappedTo, editor.schema.nodes.bulletList.create(list.node.attrs, items))
  transaction.setMeta('forageOrigin', 'agent')
  transaction.setMeta('forageChangeGroup', rootNodeId)
  editor.view.dispatch(transaction)

  const nodeIds = items
    .map((item) => item.attrs.nodeId)
    .filter((nodeId): nodeId is string => typeof nodeId === 'string' && nodeId.length > 0)
  revealAgentResult(editor, nodeIds)
  return nodeIds
}

function revealAgentResult(editor: Editor, nodeIds: string[]): void {
  const ids = new Set(nodeIds)
  const ranges: StreamingTextRange[] = []
  let wordIndex = 0
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== 'listItem' || !ids.has(String(node.attrs.nodeId))) return
    const paragraph = node.firstChild
    if (!paragraph || paragraph.type.name !== 'paragraph') return false
    for (const match of paragraph.textContent.matchAll(/\S+/gu)) {
      const start = match.index ?? 0
      ranges.push({
        from: pos + 2 + start,
        to: pos + 2 + start + match[0].length,
        delayMs: Math.min(wordIndex * 24, 360),
      })
      wordIndex += 1
    }
    return false
  })
  if (!ranges.length) return
  showStreamingText(editor, ranges)
  const clearAfter = 350 + Math.min(Math.max(0, wordIndex - 1) * 24, 360)
  window.setTimeout(() => clearStreamingText(editor), clearAfter)
}

function structuredToStored(node: StructuredResultNode): StoredOutlineNode {
  if (node.type === 'image') return { image: { assetId: node.assetId, alt: node.alt } }
  return {
    text: node.text,
    ...(node.children?.length ? { children: node.children.map(structuredToStored) } : {}),
  }
}

function replaceAiList(
  editor: Editor,
  list: { pos: number; node: ProseMirrorNode },
  items: ProseMirrorNode[],
): void {
  const tr = editor.state.tr
  tr.replaceWith(
    list.pos,
    list.pos + list.node.nodeSize,
    editor.schema.nodes.bulletList.create(list.node.attrs, items),
  )
  tr.setMeta('addToHistory', false)
  tr.setMeta('forageOrigin', 'agent')
  tr.setMeta('forageChangeGroup', String(list.node.firstChild?.attrs.nodeId ?? 'unscoped'))
  editor.view.dispatch(tr)
}

export interface Generation {
  promise: Promise<void>
  cancel: () => void
}

export function skillActivityLabel(skillLabel: string, prompt: string): string {
  const trimmedPrompt = prompt.trim()
  return `Run /${skillLabel}${trimmedPrompt ? ` ${trimmedPrompt}` : ''}`
}

/**
 * Run a skill, streaming its output into new AI bullets under the cursor.
 * Returns a handle whose cancel() aborts the in-flight request.
 */
export function runSkillIntoEditor(
  editor: Editor,
  auth: CodexAuthConfig,
  skill: Skill,
  agent: AgentDefinition,
  prompt: string,
  enabledToolIds: string[] = [],
  customTools: CustomHttpToolConfig[] = [],
  onError?: (message: string) => void,
  onActivity?: ActivityReporter,
): Generation {
  const controller = new AbortController()
  const cancel = () => controller.abort()
  const invocationNodeId = currentListItemId(editor)
  if (!invocationNodeId) throw new Error('Could not find the skill invocation bullet.')

  // Preflight must finish before creating output so invalid references and
  // oversized context never leave an empty AI placeholder behind.
  const context = resolveAgentContext(editor.state.doc, invocationNodeId)
  const outlineSnapshot = JSON.stringify(buildOutlineSnapshot(editor.state.doc))
  removeCurrentSlashCommand(editor, skill.label)
  const nodeId = insertAiChild(editor)
  if (!nodeId) throw new Error('Could not find a bullet to generate under.')
  const activityId = `skill-${nodeId}`
  const startedAt = Date.now()
  let streamedText = ''
  onActivity?.({
    id: activityId,
    phase: 'start',
    kind: 'skill',
    label: skillActivityLabel(skill.label, prompt),
    detail: prompt || 'No additional prompt',
  })

  const promise = (async () => {
    try {
      setAgentActivity(editor, nodeId, ['Thinking…'], cancel)
      await generateWithPi(
        auth,
        { skill, agent, prompt, context: context.lines, enabledToolIds, customTools, outlineSnapshot },
        {
          signal: controller.signal,
          onDelta: (textSoFar) => {
            setAgentActivity(editor, nodeId, [], cancel)
            writeAiText(editor, nodeId, textSoFar, streamedText)
            streamedText = textSoFar
          },
          onToolActivity: (notes) => setAgentActivity(editor, nodeId, notes, cancel),
          onOutline: async (nodes) => {
            setAgentActivity(editor, nodeId, [], cancel)
            writeAiOutline(editor, nodeId, await prepareAiOutline(nodes))
          },
          onActivity: onActivity
            ? (event) => onActivity({ ...event, callId: activityId })
            : undefined,
        },
      )
      setAgentActivity(editor, nodeId, null)
      onActivity?.({ id: activityId, phase: 'complete', kind: 'skill', label: skillActivityLabel(skill.label, prompt), durationMs: Date.now() - startedAt })
    } catch (e) {
      setAgentActivity(editor, nodeId, null)
      if (controller.signal.aborted) {
        onActivity?.({ id: activityId, phase: 'cancelled', kind: 'skill', label: skillActivityLabel(skill.label, prompt), durationMs: Date.now() - startedAt })
        writeAiText(editor, nodeId, '[cancelled]')
      } else {
        const message = e instanceof Error ? e.message : String(e)
        onActivity?.({ id: activityId, phase: 'error', kind: 'skill', label: skillActivityLabel(skill.label, prompt), detail: message, durationMs: Date.now() - startedAt })
        removeAiList(editor, nodeId)
        if (onError) onError(message)
        else throw e
      }
    }
  })()

  return { promise, cancel }
}
