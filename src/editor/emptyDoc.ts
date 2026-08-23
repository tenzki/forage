import { newNodeId, type JsonValue } from '../types/tree'

type PmJson = {
  type: string
  attrs?: Record<string, JsonValue>
  content?: PmJson[]
  text?: string
  marks?: JsonValue[]
}

function blankItem(): PmJson {
  return {
    type: 'listItem',
    attrs: {
      nodeId: newNodeId(),
      nodeType: 'user',
      collapsed: false,
      bulletKind: 'bullet',
      completed: false,
    },
    content: [{ type: 'paragraph' }],
  }
}

/** Keep persisted and freshly edited documents inside the outliner's root-list invariant. */
export function normalizeOutlinerDoc(doc: JsonValue): JsonValue {
  const value = doc as PmJson
  const items: PmJson[] = []
  for (const block of value.content ?? []) {
    if (block.type === 'bulletList') {
      items.push(...(block.content ?? []).filter((child) => child.type === 'listItem'))
    } else if (block.type === 'paragraph' && block.content?.length) {
      items.push({
        type: 'listItem',
        attrs: {
          nodeId: newNodeId(),
          nodeType: 'user',
          collapsed: false,
          bulletKind: 'bullet',
          completed: false,
        },
        content: [block],
      })
    }
  }
  return {
    type: 'doc',
    content: [{ type: 'bulletList', content: items.length ? items : [blankItem()] }],
  } as JsonValue
}

/** A fresh outline: one empty bullet. nodeId is filled in by BulletAttributes. */
export const EMPTY_DOC: JsonValue = normalizeOutlinerDoc({ type: 'doc' })
