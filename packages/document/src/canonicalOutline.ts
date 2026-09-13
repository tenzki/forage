import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { createOutlineSchema } from './schema'

export type CanonicalNodeState = 'live' | 'trashed' | 'missing'

export interface CanonicalOutlineState {
  doc: Record<string, unknown>
  trash: Array<Record<string, unknown>>
}

export interface CanonicalOutlineNode {
  id: string
  text: string
  parentId: string | null
  ancestorIds: string[]
  systemRole: string | null
}

export type CanonicalNodeResolution =
  | { state: 'live'; node: CanonicalOutlineNode }
  | { state: 'trashed'; trashEntryId: string }
  | { state: 'missing' }

/**
 * Parsed, immutable view of the authoritative outline document. Correctness-
 * critical operations should use this view; flattened indexes are only caches.
 */
export class CanonicalOutlineQuery {
  private readonly live = new Map<string, CanonicalOutlineNode>()
  private readonly trashed = new Map<string, string>()

  constructor(state: CanonicalOutlineState) {
    const document = createOutlineSchema().nodeFromJSON(state.doc)
    this.indexDocument(document)
    for (const entry of state.trash) this.indexTrashEntry(entry)
  }

  resolve(nodeId: string): CanonicalNodeResolution {
    const node = this.live.get(nodeId)
    if (node) return { state: 'live', node: structuredClone(node) }
    const trashEntryId = this.trashed.get(nodeId)
    return trashEntryId ? { state: 'trashed', trashEntryId } : { state: 'missing' }
  }

  liveNode(nodeId: string): CanonicalOutlineNode | null {
    const resolution = this.resolve(nodeId)
    return resolution.state === 'live' ? resolution.node : null
  }

  ancestors(nodeId: string, limit = 20): CanonicalOutlineNode[] {
    const resolved = this.resolve(nodeId)
    if (resolved.state !== 'live') return []
    const result: CanonicalOutlineNode[] = []
    let current: CanonicalOutlineNode | undefined = resolved.node
    while (current && result.length < limit) {
      result.unshift(structuredClone(current))
      current = current.parentId ? this.live.get(current.parentId) : undefined
    }
    return result
  }

  nodes(): CanonicalOutlineNode[] {
    return [...this.live.values()].map((node) => structuredClone(node))
  }

  private indexDocument(document: ProseMirrorNode): void {
    document.descendants((node, position) => {
      if (node.type.name !== 'listItem' || typeof node.attrs.nodeId !== 'string') return
      const id = node.attrs.nodeId
      if (this.live.has(id)) throw new Error(`Canonical outline contains duplicate node id: ${id}`)
      const resolved = document.resolve(position)
      const ancestorIds: string[] = []
      for (let depth = 1; depth <= resolved.depth; depth += 1) {
        const ancestor = resolved.node(depth)
        if (ancestor.type.name === 'listItem' && typeof ancestor.attrs.nodeId === 'string') {
          ancestorIds.push(ancestor.attrs.nodeId)
        }
      }
      this.live.set(id, {
        id,
        text: node.firstChild?.type.name === 'paragraph' ? node.firstChild.textContent : '',
        parentId: ancestorIds.length ? ancestorIds[ancestorIds.length - 1]! : null,
        ancestorIds,
        systemRole: typeof node.attrs.systemRole === 'string' ? node.attrs.systemRole : null,
      })
    })
  }

  private indexTrashEntry(entry: Record<string, unknown>): void {
    const trashEntryId = typeof entry.id === 'string' ? entry.id : ''
    const visit = (value: unknown): void => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return
      const node = value as { type?: unknown; attrs?: unknown; content?: unknown }
      if (node.type === 'listItem' && node.attrs && typeof node.attrs === 'object') {
        const id = (node.attrs as Record<string, unknown>).nodeId
        if (typeof id === 'string' && !this.live.has(id)) this.trashed.set(id, trashEntryId)
      }
      if (Array.isArray(node.content)) node.content.forEach(visit)
    }
    visit(entry.node)
  }
}

export function queryCanonicalOutline(state: CanonicalOutlineState): CanonicalOutlineQuery {
  return new CanonicalOutlineQuery(state)
}
