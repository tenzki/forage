import type { Editor } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { TextSelection } from '@tiptap/pm/state'

export interface BulletEntry {
  id: string
  text: string
  pos: number
  node: ProseMirrorNode
  parentListPos: number
  siblingIndex: number
  ancestorIds: string[]
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

export function findBullet(
  doc: ProseMirrorNode,
  nodeId: string,
): BulletEntry | null {
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

function replaceSiblingOrder(
  editor: Editor,
  source: BulletEntry,
  target: BulletEntry,
  placeAfter: boolean,
): boolean {
  if (source.parentListPos !== target.parentListPos || source.id === target.id) {
    return false
  }
  const list = editor.state.doc.nodeAt(source.parentListPos)
  if (!list || list.type.name !== 'bulletList') return false
  const children: ProseMirrorNode[] = []
  list.forEach((child) => children.push(child))
  const [moving] = children.splice(source.siblingIndex, 1)
  const targetIndex = children.findIndex((child) => child.attrs.nodeId === target.id)
  if (!moving || targetIndex < 0) return false
  children.splice(targetIndex + (placeAfter ? 1 : 0), 0, moving)

  const transaction = editor.state.tr.replaceWith(
    source.parentListPos,
    source.parentListPos + list.nodeSize,
    list.type.create(list.attrs, children),
  )
  const moved = findBullet(transaction.doc, source.id)
  if (moved) transaction.setSelection(TextSelection.near(transaction.doc.resolve(moved.pos + 2)))
  editor.view.dispatch(transaction.scrollIntoView())
  return true
}

export function moveBulletById(
  editor: Editor,
  nodeId: string,
  direction: -1 | 1,
): boolean {
  const source = findBullet(editor.state.doc, nodeId)
  if (!source) return false
  const siblings = collectBullets(editor.state.doc).filter(
    (entry) => entry.parentListPos === source.parentListPos,
  )
  const target = siblings[source.siblingIndex + direction]
  if (!target) return false
  return replaceSiblingOrder(editor, source, target, direction > 0)
}

export function moveCurrentBullet(editor: Editor, direction: -1 | 1): boolean {
  const id = currentBulletId(editor)
  return id ? moveBulletById(editor, id, direction) : false
}

export function reorderBullet(
  editor: Editor,
  sourceId: string,
  targetId: string,
  placeAfter: boolean,
): boolean {
  const source = findBullet(editor.state.doc, sourceId)
  const target = findBullet(editor.state.doc, targetId)
  if (!source || !target) return false
  return replaceSiblingOrder(editor, source, target, placeAfter)
}

export function selectBullet(editor: Editor, nodeId: string): boolean {
  const entry = findBullet(editor.state.doc, nodeId)
  if (!entry) return false
  editor.commands.setTextSelection(entry.pos + 2)
  editor.commands.focus()
  return true
}

export function breadcrumbFor(
  doc: ProseMirrorNode,
  nodeId: string | null,
): BulletEntry[] {
  if (!nodeId) return []
  const entries = collectBullets(doc)
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const target = byId.get(nodeId)
  if (!target) return []
  return [...target.ancestorIds, target.id]
    .map((id) => byId.get(id))
    .filter((entry): entry is BulletEntry => Boolean(entry))
}
