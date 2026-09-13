import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Transform } from '@tiptap/pm/transform'

export function insertPlainTextNote(
  document: ProseMirrorNode,
  input: { noteId: string; parentId: string; text: string },
): ProseMirrorNode {
  let parent: { node: ProseMirrorNode; pos: number } | null = null
  let duplicate = false
  document.descendants((node, pos) => {
    if (node.type.name !== 'listItem') return
    if (node.attrs.nodeId === input.noteId) duplicate = true
    if (node.attrs.nodeId === input.parentId) parent = { node, pos }
  })
  if (duplicate) throw new Error(`Note id ${input.noteId} already exists`)
  if (!parent) throw new Error(`Parent note ${input.parentId} does not exist`)

  const schema = document.type.schema
  const inline: ProseMirrorNode[] = []
  input.text.split('\n').forEach((line, index) => {
    if (index > 0) inline.push(schema.nodes.hardBreak.create())
    if (line) inline.push(schema.text(line))
  })
  const item = schema.nodes.listItem.create({
    nodeId: input.noteId,
    nodeType: 'user',
    collapsed: false,
    bulletKind: 'bullet',
    completed: false,
  }, schema.nodes.paragraph.create(null, inline))
  const found = parent as { node: ProseMirrorNode; pos: number }
  let nestedOffset: number | null = null
  let offset = 0
  found.node.forEach((child) => {
    if (nestedOffset === null && child.type.name === 'bulletList') nestedOffset = offset
    offset += child.nodeSize
  })
  const transform = new Transform(document)
  if (nestedOffset === null) {
    transform.insert(found.pos + found.node.nodeSize - 1, schema.nodes.bulletList.create(null, item))
  } else {
    const nested = found.node.nodeAt(nestedOffset)!
    transform.insert(found.pos + 1 + nestedOffset + 1 + nested.content.size, item)
  }
  return transform.doc
}

export interface AgentResultTreeNode {
  type: 'text' | 'image'
  nodeId?: string
  text?: string
  assetId?: string
  alt?: string
  children?: AgentResultTreeNode[]
}

/** Applies a complete generated subtree to a document value as one reducer operation. */
export function insertAgentResult(
  document: ProseMirrorNode,
  input: { targetNodeId: string; nodes: AgentResultTreeNode[] },
): ProseMirrorNode {
  let projected = document
  const insert = (nodes: AgentResultTreeNode[], parentId: string): void => {
    for (const node of nodes) {
      if (node.type === 'text') {
        if (!node.nodeId || !node.text) throw new Error('Generated text nodes require an id and text')
        projected = insertPlainTextNote(projected, { noteId: node.nodeId, parentId, text: node.text })
        if (node.children?.length) insert(node.children, node.nodeId)
        continue
      }
      if (!node.assetId || !node.alt) throw new Error('Generated images require an asset id and alt text')
      projected = insertGeneratedImage(projected, parentId, node.assetId, node.alt)
    }
  }
  insert(input.nodes, input.targetNodeId)
  return projected
}

function insertGeneratedImage(document: ProseMirrorNode, parentId: string, assetId: string, alt: string): ProseMirrorNode {
  let parent: { node: ProseMirrorNode; pos: number } | null = null
  document.descendants((node, pos) => {
    if (node.type.name === 'listItem' && node.attrs.nodeId === parentId) parent = { node, pos }
  })
  if (!parent) throw new Error(`Parent note ${parentId} does not exist`)
  const schema = document.type.schema
  const image = schema.nodes.generatedImageItem.create(null, schema.nodes.generatedImage.create({ assetId, alt }))
  const found = parent as { node: ProseMirrorNode; pos: number }
  let nestedOffset: number | null = null
  let offset = 0
  found.node.forEach((child) => {
    if (nestedOffset === null && child.type.name === 'bulletList') nestedOffset = offset
    offset += child.nodeSize
  })
  const transform = new Transform(document)
  if (nestedOffset === null) {
    transform.insert(found.pos + found.node.nodeSize - 1, schema.nodes.bulletList.create(null, image))
  } else {
    const nested = found.node.nodeAt(nestedOffset)!
    transform.insert(found.pos + 1 + nestedOffset + 1 + nested.content.size, image)
  }
  return transform.doc
}
