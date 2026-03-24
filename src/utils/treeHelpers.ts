import { generateKeyBetween } from 'fractional-indexing'
import type { TreeNode } from '../types/tree'

/**
 * Compute a fractional position for inserting after the node at `afterIndex`.
 *
 * `afterIndex = -1` means insert before the first sibling.
 * `afterIndex = siblings.length - 1` means insert after the last sibling.
 * `siblings` must be sorted by position ASC.
 */
export function positionForInsertAfter(
  siblings: TreeNode[],
  afterIndex: number,
): string {
  const prevPos = afterIndex >= 0 ? siblings[afterIndex]?.position ?? null : null
  const nextPos = afterIndex < siblings.length - 1
    ? siblings[afterIndex + 1]?.position ?? null
    : null

  return generateKeyBetween(prevPos, nextPos)
}

/**
 * Compute a fractional position for a drag-move operation.
 *
 * Excludes nodes whose id is in `dragIds` from the sibling list before
 * calculating the position, so the dragged nodes do not affect the key range.
 *
 * `targetIndex` is the intended final index within the remaining (non-dragged) siblings.
 * `siblings` must be sorted by position ASC.
 */
export function positionForMove(
  siblings: TreeNode[],
  targetIndex: number,
  dragIds: string[],
): string {
  const dragSet = new Set(dragIds)
  const remaining = siblings.filter((n) => !dragSet.has(n.id))

  const prevPos = targetIndex > 0 ? remaining[targetIndex - 1]?.position ?? null : null
  const nextPos = targetIndex < remaining.length ? remaining[targetIndex]?.position ?? null : null

  return generateKeyBetween(prevPos, nextPos)
}

/**
 * Build a breadcrumb path from root to a target node.
 *
 * Returns an array of TreeNodes from root to the target (inclusive).
 * Returns empty array if the targetId is not found.
 */
export function buildBreadcrumb(nodes: TreeNode[], targetId: string): TreeNode[] {
  function findPath(current: TreeNode[], id: string, path: TreeNode[]): TreeNode[] | null {
    for (const node of current) {
      const newPath = [...path, node]
      if (node.id === id) return newPath
      const found = findPath(node.children, id, newPath)
      if (found) return found
    }
    return null
  }
  return findPath(nodes, targetId, []) ?? []
}

/**
 * Hydrate a flat array of nodes (with parent_id references) into nested children arrays.
 *
 * Builds a tree by grouping nodes by parent_id and recursively assigning children.
 * Root nodes have parent_id = null.
 */
export function hydrateChildren(flat: TreeNode[]): TreeNode[] {
  const byParent = new Map<string | null, TreeNode[]>()

  for (const node of flat) {
    const key = node.parent_id ?? null
    const list = byParent.get(key) ?? []
    list.push({ ...node, children: [] })
    byParent.set(key, list)
  }

  function attach(parentId: string | null): TreeNode[] {
    const children = byParent.get(parentId) ?? []
    return children
      .sort((a, b) => a.position.localeCompare(b.position))
      .map((node) => ({ ...node, children: attach(node.id) }))
  }

  return attach(null)
}
