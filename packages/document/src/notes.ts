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
