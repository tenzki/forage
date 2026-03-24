import type { TreeNode } from '../../types/tree'
import { useTreeStore } from '../../store/treeStore'

interface BulletProps {
  node: TreeNode
}

/**
 * Workflowy-style bullet: a small filled circle with an optional expand/collapse triangle.
 *
 * Triangle (left of bullet): click to toggle expand/collapse
 * Bullet (filled circle): click to zoom into the node
 */
export default function Bullet({ node }: BulletProps) {
  const toggleNode = useTreeStore((s) => s.toggleNode)
  const zoomIn = useTreeStore((s) => s.zoomIn)

  const hasChildren = node.children.length > 0 || !node.collapsed

  function handleToggle(e: React.MouseEvent) {
    e.stopPropagation()
    toggleNode(node.id)
  }

  function handleZoom(e: React.MouseEvent) {
    e.stopPropagation()
    zoomIn(node.id)
  }

  return (
    <span className="bullet-wrapper">
      {/* Expand/collapse triangle — only shown when node has children */}
      <span
        className={`bullet-toggle${hasChildren ? '' : ' bullet-toggle--hidden'}`}
        style={{ transform: node.collapsed ? 'rotate(0deg)' : 'rotate(90deg)' }}
        onClick={handleToggle}
        title={node.collapsed ? 'Expand' : 'Collapse'}
      >
        ▶
      </span>

      {/* Filled circle — click to zoom */}
      <span
        className="bullet-dot"
        onClick={handleZoom}
        title="Zoom into node"
      />
    </span>
  )
}
