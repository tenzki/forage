import type { Node, JsonValue } from '../lib/bindings'

/** TreeNode is the nested shape react-arborist consumes */
export interface TreeNode {
  id: string
  name: string           // plain text extracted from content JSON
  content: JsonValue
  position: string
  collapsed: boolean
  parent_id: string | null
  node_type: string
  children: TreeNode[]   // always array (never undefined) for Workflowy-style any-node-can-have-children
}

/** Extract plain text from ProseMirror JSON content for display */
export function extractText(content: JsonValue): string {
  if (content === null || content === undefined) return ''
  if (typeof content !== 'object' || Array.isArray(content)) return ''

  const doc = content as Record<string, JsonValue>

  // Walk ProseMirror doc > paragraph > text nodes, concatenate text
  const contentArray = doc['content']
  if (!Array.isArray(contentArray)) return ''

  let result = ''
  for (const block of contentArray) {
    if (typeof block !== 'object' || block === null || Array.isArray(block)) continue
    const blockNode = block as Record<string, JsonValue>
    const inlines = blockNode['content']
    if (!Array.isArray(inlines)) continue
    for (const inline of inlines) {
      if (typeof inline !== 'object' || inline === null || Array.isArray(inline)) continue
      const inlineNode = inline as Record<string, JsonValue>
      if (inlineNode['type'] === 'text' && typeof inlineNode['text'] === 'string') {
        result += inlineNode['text']
      }
    }
  }
  return result
}

/** Convert a backend Node to a TreeNode (without children populated) */
export function nodeToTreeNode(node: Node): TreeNode {
  return {
    id: node.id,
    name: extractText(node.content),
    content: node.content,
    position: node.position,
    collapsed: node.collapsed,
    parent_id: node.parent_id,
    node_type: node.node_type,
    children: [],
  }
}
