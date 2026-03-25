import { useEffect, useRef, useState } from 'react'
import { Tree } from 'react-arborist'
import { createDragDropManager } from 'dnd-core'
import { TouchBackend } from 'react-dnd-touch-backend'
import { useTreeStore } from '../../store/treeStore'
import NodeRow from './NodeRow'
import Breadcrumb from './Breadcrumb'
import { positionForMove } from '../../utils/treeHelpers'
import { moveNodeIpc } from '../../store/ipc'
import type { TreeNode } from '../../types/tree'

// Use TouchBackend instead of HTML5Backend — HTML5 DnD doesn't work in Tauri's WebView
// delayTouchStart prevents drag from triggering on normal clicks/selections
const dndManager = createDragDropManager(TouchBackend, undefined, {
  enableMouseEvents: true,
  enableTouchEvents: true,
  delay: 150,
  delayTouchStart: 150,
})

function DropCursor({ top, left, indent }: { top: number; left: number; indent: number }) {
  return (
    <div
      style={{
        position: 'absolute',
        pointerEvents: 'none',
        top: top - 1,
        left: left,
        right: indent,
        display: 'flex',
        alignItems: 'center',
        zIndex: 100,
      }}
    >
      <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#2563eb' }} />
      <div style={{ flex: 1, height: 2, background: '#2563eb', borderRadius: 1 }} />
    </div>
  )
}

/**
 * Custom Row renderer that skips react-arborist's built-in click selection.
 * We manage focus/selection entirely via our Zustand store.
 */
function CustomRow({ attrs, innerRef, children }: any) {
  return (
    <div
      {...attrs}
      ref={innerRef}
      onFocus={(e: React.FocusEvent) => e.stopPropagation()}
      children={children}
    />
  )
}

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
    isDraggingRef.current = true
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

    // Move each dragged node via IPC only — then reload tree from DB
    for (const dragId of dragIds) {
      try {
        await moveNodeIpc(dragId, parentId, newPosition)
      } catch (e) {
        console.error('DnD move failed:', e)
      }
    }

    // Reload from DB to get correct positions
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




  const zoomedNodeId = useTreeStore((s) => s.zoomedNodeId)

  const isDraggingRef = useRef(false)

  async function handleEmptyClick(e: React.MouseEvent) {
    // Don't create nodes when a drag-drop just finished
    if (isDraggingRef.current) {
      isDraggingRef.current = false
      return
    }
    // Only fire if clicking truly empty space — not inside any tree row or node
    const target = e.target as HTMLElement
    if (target.closest('.node-row') || target.closest('[role="treeitem"]') || target.closest('[role="tree"]')) return
    try {
      // When zoomed, new nodes are children of the zoomed node
      await createNode(zoomedNodeId, null)
    } catch (e) {
      console.error('Failed to create node:', e)
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
          renderCursor={DropCursor}
          dndManager={dndManager}
          disableMultiSelection={true}
          renderRow={CustomRow}
        >
          {NodeRow}
        </Tree>
      </div>
    </div>
  )
}
