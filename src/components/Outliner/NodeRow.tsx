import type { NodeRendererProps } from 'react-arborist'
import type { TreeNode } from '../../types/tree'
import Bullet from './Bullet'

/**
 * react-arborist node renderer for Workflowy-style outliner rows.
 * Renders: Bullet (expand/collapse + zoom) + plain text label.
 * TipTap rich text editor is wired in Plan 03.
 */
export default function NodeRow({ node, style, dragHandle }: NodeRendererProps<TreeNode>) {
  const isSelected = node.isSelected

  return (
    <div
      style={style}
      ref={dragHandle}
      className={`node-row${isSelected ? ' node-row--selected' : ''}`}
    >
      <Bullet node={node.data} />
      <span className="node-text">
        {node.data.name || <span className="node-text--empty">Untitled</span>}
      </span>
    </div>
  )
}
