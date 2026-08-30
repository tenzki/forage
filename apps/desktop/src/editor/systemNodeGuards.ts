import type { Node as ProseMirrorNode } from '@tiptap/pm/model'

export const SYSTEM_TITLE_UPDATE_META = 'forageSystemTitleUpdate'
export const SYSTEM_MAINTENANCE_META = 'forageSystemMaintenance'
export const SYSTEM_NODE_TRASH_META = 'forageSystemNodeTrash'
export const SYSTEM_NODE_REJECTION_EVENT = 'forage-system-node-rejected'
export const SYSTEM_NODE_REJECTION_MESSAGE = 'Inbox and Daily Notes titles are protected.'

export type StructuralAction = 'move' | 'trash' | 'purge' | 'restore' | 'duplicate' | 'convert' | 'replace'

export type StructuralDecision = { allowed: true } | { allowed: false; message: string }

interface ProtectedNodeSnapshot {
  role: string
  dailyDate: string | null
  nodeType: string
  bulletKind: string
  completed: boolean
  paragraph: ProseMirrorNode | null
  ancestorIds: string[]
}

function protectedNodeSnapshots(doc: ProseMirrorNode): Map<string, ProtectedNodeSnapshot> {
  const snapshots = new Map<string, ProtectedNodeSnapshot>()
  doc.descendants((node, pos) => {
    const role = node.type.name === 'listItem' ? String(node.attrs.systemRole ?? '') : ''
    const nodeId = String(node.attrs.nodeId ?? '')
    if (!nodeId || (role !== 'inbox' && role !== 'daily-notes' && role !== 'daily-note')) return
    const resolved = doc.resolve(pos)
    const ancestorIds: string[] = []
    for (let depth = 1; depth <= resolved.depth; depth += 1) {
      const ancestor = resolved.node(depth)
      if (ancestor.type.name === 'listItem' && ancestor.attrs.nodeId) {
        ancestorIds.push(String(ancestor.attrs.nodeId))
      }
    }
    snapshots.set(nodeId, {
      role,
      dailyDate: node.attrs.dailyDate ?? null,
      nodeType: String(node.attrs.nodeType ?? 'user'),
      bulletKind: String(node.attrs.bulletKind ?? 'bullet'),
      completed: Boolean(node.attrs.completed),
      paragraph: node.firstChild?.type.name === 'paragraph' ? node.firstChild : null,
      ancestorIds,
    })
  })
  return snapshots
}

/** Reject direct editor transactions that mutate or remove protected role holders. */
export function preservesProtectedSystemNodes(
  before: ProseMirrorNode,
  after: ProseMirrorNode,
  allowedTitleId?: string | null,
  allowedTrashId?: string | null,
): boolean {
  const previous = protectedNodeSnapshots(before)
  if (!previous.size) return true
  const next = protectedNodeSnapshots(after)
  for (const [nodeId, oldNode] of previous) {
    const newNode = next.get(nodeId)
    if (!newNode) {
      if (oldNode.role === 'daily-note' && nodeId === allowedTrashId) continue
      return false
    }
    if (
      newNode.role !== oldNode.role
      || newNode.dailyDate !== oldNode.dailyDate
      || newNode.nodeType !== oldNode.nodeType
      || newNode.bulletKind !== oldNode.bulletKind
      || newNode.completed !== oldNode.completed
      || newNode.ancestorIds.join('\0') !== oldNode.ancestorIds.join('\0')
    ) return false
    if (nodeId !== allowedTitleId) {
      const sameParagraph = newNode.paragraph && oldNode.paragraph
        ? newNode.paragraph.eq(oldNode.paragraph)
        : newNode.paragraph === oldNode.paragraph
      if (!sameParagraph) return false
    }
  }
  return true
}

export function validateSystemNodeAction(
  doc: ProseMirrorNode,
  action: StructuralAction,
  sourceId: string,
  targetId?: string | null,
): StructuralDecision {
  let source: ProseMirrorNode | null = null
  let targetExists = targetId == null
  const sourceDescendants = new Set<string>()
  doc.descendants((node) => {
    if (node.type.name !== 'listItem') return
    if (node.attrs.nodeId === sourceId) {
      source = node
      node.descendants((descendant) => {
        if (descendant.type.name === 'listItem' && descendant.attrs.nodeId) {
          sourceDescendants.add(String(descendant.attrs.nodeId))
        }
      })
    }
    if (node.attrs.nodeId === targetId) targetExists = true
  })
  if (!source) return { allowed: false, message: 'That outline item no longer exists.' }
  if (targetId != null && !targetExists) {
    return { allowed: false, message: 'The selected destination no longer exists.' }
  }
  if (action === 'move' && (targetId === sourceId || (targetId != null && sourceDescendants.has(targetId)))) {
    return { allowed: false, message: 'A branch cannot be moved into itself.' }
  }
  const role = (source as ProseMirrorNode).attrs.systemRole
  if (role === 'daily-note' && action === 'trash') return { allowed: true }
  if (role === 'inbox' || role === 'daily-notes' || role === 'daily-note') {
    const label = role === 'inbox' ? 'Inbox' : role === 'daily-notes' ? 'Daily Notes' : 'daily note'
    return { allowed: false, message: `${label} is a protected system item.` }
  }
  return { allowed: true }
}
