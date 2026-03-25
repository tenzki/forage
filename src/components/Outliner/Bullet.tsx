import { useRef } from 'react'
import type { TreeNode } from '../../types/tree'
import { useTreeStore } from '../../store/treeStore'

interface BulletProps {
  node: TreeNode
}

const CLICK_THRESHOLD = 200 // ms — anything longer is a drag, not a click

/**
 * 4-point sparkle/star icon for AI-generated nodes.
 * 12x12px, filled with purple-500 (#8b5cf6) via CSS.
 */
function SparkleIcon() {
  return (
    <svg viewBox="0 0 12 12" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M6 0 L6.9 4.5 L11 6 L6.9 7.5 L6 12 L5.1 7.5 L1 6 L5.1 4.5 Z" />
    </svg>
  )
}

/**
 * Workflowy-style bullet: a small filled circle with an optional expand/collapse triangle.
 *
 * Triangle (left of bullet): click to toggle expand/collapse
 * Bullet (filled circle): short click to zoom, long press to drag
 * Sparkle icon: shown instead of bullet dot for agent_response nodes
 */
export default function Bullet({ node }: BulletProps) {
  const toggleNode = useTreeStore((s) => s.toggleNode)
  const zoomIn = useTreeStore((s) => s.zoomIn)
  const mouseDownTime = useRef(0)

  const hasChildren = node.children.length > 0 || node.collapsed
  const isAiNode = node.node_type === 'agent_response'

  function handleToggle(e: React.MouseEvent) {
    e.stopPropagation()
    toggleNode(node.id)
  }

  function handleDotMouseDown() {
    mouseDownTime.current = Date.now()
  }

  function handleZoom(e: React.MouseEvent) {
    e.stopPropagation()
    // Only zoom on short clicks — long press is for drag
    if (Date.now() - mouseDownTime.current < CLICK_THRESHOLD) {
      zoomIn(node.id)
    }
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

      {/* Bullet: sparkle for AI nodes, filled circle for regular nodes */}
      {isAiNode ? (
        <span
          className="bullet-ai"
          onMouseDown={handleDotMouseDown}
          onClick={handleZoom}
          title="AI-generated node"
        >
          <SparkleIcon />
        </span>
      ) : (
        <span
          className="bullet-dot"
          onMouseDown={handleDotMouseDown}
          onClick={handleZoom}
          title="Zoom into node"
        />
      )}
    </span>
  )
}
