import { useEffect, useRef, useState } from 'react'
import { Tree } from 'react-arborist'
import { useTreeStore } from '../../store/treeStore'
import NodeRow from './NodeRow'
import Breadcrumb from './Breadcrumb'
import { positionForMove } from '../../utils/treeHelpers'
import type { TreeNode } from '../../types/tree'

interface MovePayload {
  dragIds: string[]
  parentId: string | null
  index: number
}

interface DeletePayload {
  ids: string[]
}

/**
 * Root outliner container.
 * Uses react-arborist Tree in controlled mode (data prop).
 * Expand/collapse and all mutations are handled via treeStore.
 * Drag-and-drop uses react-arborist built-in DnD via onMove callback.
 */
export default function OutlinerView() {
  const nodes = useTreeStore((s) => s.nodes)
  const isLoading = useTreeStore((s) => s.isLoading)
  const toggleNode = useTreeStore((s) => s.toggleNode)
  const loadTree = useTreeStore((s) => s.loadTree)
  const moveNode = useTreeStore((s) => s.moveNode)
  const deleteNode = useTreeStore((s) => s.deleteNode)
  const createNode = useTreeStore((s) => s.createNode)

  const containerRef = useRef<HTMLDivElement>(null)
  const [dimensions, setDimensions] = useState({ width: window.innerWidth, height: window.innerHeight })

  // Load tree on mount
  useEffect(() => {
    loadTree()
  }, [loadTree])

  // Update dimensions on resize
  useEffect(() => {
    function onResize() {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect()
        setDimensions({ width: rect.width, height: rect.height })
      }
    }

    onResize()

    const observer = new ResizeObserver(onResize)
    if (containerRef.current) observer.observe(containerRef.current)

    return () => observer.disconnect()
  }, [])

  function handleToggle(id: string) {
    toggleNode(id)
  }

  /**
   * Handle drag-and-drop move from react-arborist.
   * onMove provides { dragIds, parentId, index } where:
   * - parentId is the DROP target parent (null = root)
   * - index is the position among the target parent's children
   */
  async function handleMove({ dragIds, parentId, index }: MovePayload) {
    // Get siblings at the target parent (excluding dragged nodes)
    function findChildren(list: TreeNode[], id: string | null): TreeNode[] {
      if (id === null) return list
      for (const n of list) {
        if (n.id === id) return n.children
        const found = findChildren(n.children, id)
        if (found.length > 0 || n.children.some((c) => c.id === id)) return found
      }
      return []
    }

    const targetSiblings = findChildren(nodes, parentId)
    const newPosition = positionForMove(targetSiblings, index, dragIds)

    // Move each dragged node (typically just one, but handle multiple)
    for (const dragId of dragIds) {
      try {
        await moveNode(dragId, parentId, newPosition)
      } catch (e) {
        console.error('DnD move failed:', e)
      }
    }

    // Reload to ensure consistency after DnD
    await loadTree()
  }

  /**
   * Handle delete from react-arborist (e.g., pressing Delete key in tree).
   */
  async function handleDelete({ ids }: DeletePayload) {
    for (const id of ids) {
      try {
        await deleteNode(id)
      } catch (e) {
        console.error('Delete failed:', e)
      }
    }
  }

  async function handleEmptyClick(e: React.MouseEvent) {
    // Only fire if clicking the empty container (not a node row)
    if ((e.target as HTMLElement).closest('.node-row')) return
    try {
      await createNode(null, null)
    } catch (e) {
      console.error('Failed to create root node:', e)
    }
  }

  return (
    <div className="outliner-container" ref={containerRef}>
      <Breadcrumb />

      {isLoading && nodes.length === 0 && (
        <div className="outliner-loading">Loading…</div>
      )}

      {!isLoading && nodes.length === 0 && (
        <div
          className="outliner-empty"
          onClick={handleEmptyClick}
          style={{ cursor: 'text' }}
        >
          Press Enter or click here to create your first note
        </div>
      )}

      <div
        className="outliner-tree"
        style={{ opacity: isLoading ? 0.6 : 1, transition: 'opacity 150ms ease' }}
        onClick={handleEmptyClick}
      >
        <Tree<TreeNode>
          data={nodes}
          onToggle={handleToggle}
          onMove={handleMove}
          onDelete={handleDelete}
          rowHeight={28}
          indent={24}
          openByDefault={true}
          width={dimensions.width - 40}
          height={dimensions.height - 60}
        >
          {NodeRow}
        </Tree>
      </div>
    </div>
  )
}
