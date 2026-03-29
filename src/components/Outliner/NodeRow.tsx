import { useState, useEffect, useRef } from 'react'
import type { NodeRendererProps } from 'react-arborist'
import type { TreeNode } from '../../types/tree'
import Bullet from './Bullet'
import NodeEditor from './NodeEditor'
import { useTreeStore } from '../../store/treeStore'
import { useAgentStore } from '../../store/agentStore'
import { changeNodeTypeIpc } from '../../store/ipc'
import { generateHTML } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { HashtagNode } from '../../extensions/HashtagNode'

const readOnlyExtensions = [
  StarterKit.configure({
    heading: false,
    blockquote: false,
    codeBlock: false,
    horizontalRule: false,
    bulletList: false,
    orderedList: false,
    listItem: false,
  }),
  HashtagNode,
]

/**
 * react-arborist node renderer for Workflowy-style outliner rows.
 *
 * Performance pattern: Only one TipTap instance is mounted at a time.
 * - If this node is the editingNodeId → render NodeEditor (TipTap)
 * - All other nodes → render plain <span> with node.data.name
 *
 * Range selection highlight: nodes in selectedNodeIds get a subtle blue background.
 *
 * Context menu: right-clicking an agent_response node shows a "Make mine" option
 * that converts it to a regular note, removing the sparkle icon immediately.
 *
 * Streaming indicator: ghost nodes with an active generation show a pulsing
 * animation. Cancelled/partial nodes show a dimmed appearance.
 */
export default function NodeRow({ node, style, dragHandle }: NodeRendererProps<TreeNode>) {
  const editingNodeId = useTreeStore((s) => s.editingNodeId)
  const selectedNodeIds = useTreeStore((s) => s.selectedNodeIds)
  const setEditingNode = useTreeStore((s) => s.setEditingNode)
  const clearSelection = useTreeStore((s) => s.clearSelection)
  const updateNodeLocally = useTreeStore((s) => s.updateNodeLocally)
  const activeGenerations = useAgentStore((s) => s.activeGenerations)

  const isEditing = editingNodeId === node.data.id
  const isRangeSelected = selectedNodeIds.has(node.data.id)

  // Check if this node is the ghost node of an active generation
  const isGenerating = Array.from(activeGenerations.values()).some(
    (gen) => gen.ghostNodeId === node.data.id && gen.status === 'streaming'
  )

  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)
  const ctxMenuRef = useRef<HTMLDivElement>(null)

  function handleTextClick(e: React.MouseEvent) {
    e.stopPropagation()
    clearSelection()
    setEditingNode(node.data.id)
  }

  function handleRowClick() {
    clearSelection()
  }

  function handleContextMenu(e: React.MouseEvent) {
    // Only show context menu for AI nodes that are not currently generating
    if (node.data.node_type !== 'agent_response') return
    if (isGenerating) return
    e.preventDefault()
    e.stopPropagation()
    setCtxMenu({ x: e.clientX, y: e.clientY })
  }

  async function handleMakeMine() {
    setCtxMenu(null)
    try {
      await changeNodeTypeIpc(node.data.id, 'note')
      updateNodeLocally(node.data.id, { node_type: 'note' })
    } catch (e) {
      console.error('Failed to convert AI node:', e)
    }
  }

  // Close context menu on outside click or Escape key
  useEffect(() => {
    if (!ctxMenu) return

    function handleClickOutside(e: MouseEvent) {
      if (ctxMenuRef.current && !ctxMenuRef.current.contains(e.target as Node)) {
        setCtxMenu(null)
      }
    }

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setCtxMenu(null)
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [ctxMenu])

  let className = 'node-row'
  if (isRangeSelected) className += ' node-row-range-selected'
  if (node.isDragging) className += ' node-row-dragging'
  if (node.willReceiveDrop) className += ' node-row-drop-target'
  if (isGenerating) className += ' node-generating'

  return (
    <>
      <div
        style={style}
        ref={dragHandle}
        className={className}
        onClick={handleRowClick}
        onContextMenu={handleContextMenu}
      >
        <Bullet node={node.data} />

        {isEditing ? (
          <NodeEditor node={node.data} />
        ) : (
          node.data.content && typeof node.data.content === 'object' && (node.data.content as any).type === 'doc' ? (
            <span
              className="node-text node-text--rich"
              onClick={handleTextClick}
              dangerouslySetInnerHTML={{
                __html: (() => {
                  try {
                    return generateHTML(node.data.content as any, readOnlyExtensions)
                  } catch {
                    return node.data.name || ''
                  }
                })(),
              }}
            />
          ) : (
            <span className="node-text" onClick={handleTextClick}>
              {node.data.name || <span className="node-text--empty">Click to edit</span>}
            </span>
          )
        )}
      </div>

      {ctxMenu && (
        <div
          ref={ctxMenuRef}
          className="context-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
        >
          <div
            className="context-menu-item"
            onClick={handleMakeMine}
            role="menuitem"
          >
            Make mine
          </div>
        </div>
      )}
    </>
  )
}
