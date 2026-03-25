import type { NodeRendererProps } from 'react-arborist'
import type { TreeNode } from '../../types/tree'
import Bullet from './Bullet'
import NodeEditor from './NodeEditor'
import { useTreeStore } from '../../store/treeStore'

/**
 * react-arborist node renderer for Workflowy-style outliner rows.
 *
 * Performance pattern: Only one TipTap instance is mounted at a time.
 * - If this node is the editingNodeId → render NodeEditor (TipTap)
 * - All other nodes → render plain <span> with node.data.name
 *
 * Range selection highlight: nodes in selectedNodeIds get a subtle blue background.
 */
export default function NodeRow({ node, style, dragHandle }: NodeRendererProps<TreeNode>) {
  const editingNodeId = useTreeStore((s) => s.editingNodeId)
  const selectedNodeIds = useTreeStore((s) => s.selectedNodeIds)
  const setEditingNode = useTreeStore((s) => s.setEditingNode)
  const clearSelection = useTreeStore((s) => s.clearSelection)

  const isEditing = editingNodeId === node.data.id
  const isRangeSelected = selectedNodeIds.has(node.data.id)

  function handleTextClick(e: React.MouseEvent) {
    e.stopPropagation()
    clearSelection()
    setEditingNode(node.data.id)
  }

  function handleRowClick() {
    clearSelection()
  }


  let className = 'node-row'
  if (isRangeSelected) className += ' node-row-range-selected'
  if (node.isDragging) className += ' node-row-dragging'
  if (node.willReceiveDrop) className += ' node-row-drop-target'

  return (
    <div
      style={style}
      ref={dragHandle}
      className={className}
      onClick={handleRowClick}
    >
      <Bullet node={node.data} />

      {isEditing ? (
        <NodeEditor node={node.data} />
      ) : (
        <span
          className="node-text"
          onClick={handleTextClick}
        >
          {node.data.name || <span className="node-text--empty">Click to edit</span>}
        </span>
      )}
    </div>
  )
}
