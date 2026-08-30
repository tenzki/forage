import { newNodeId, type JsonValue } from '../types/tree'
import { repairSystemNodes } from '@forage/document'

type PmJson = {
  type: string
  attrs?: Record<string, JsonValue>
  content?: PmJson[]
  text?: string
  marks?: JsonValue[]
}

function blankItem(nextId: () => string): PmJson {
  return {
    type: 'listItem',
    attrs: {
      nodeId: nextId(),
      nodeType: 'user',
      collapsed: false,
      bulletKind: 'bullet',
      completed: false,
    },
    content: [{ type: 'paragraph' }],
  }
}

/** Keep persisted and freshly edited documents inside the outliner's root-list invariant. */
export function normalizeOutlinerDoc(doc: JsonValue, nextId: () => string = newNodeId): JsonValue {
  const value = doc as PmJson
  const items: PmJson[] = []
  for (const block of value.content ?? []) {
    if (block.type === 'bulletList') {
      items.push(...(block.content ?? []).filter((child) => child.type === 'listItem'))
    } else if (block.type === 'paragraph' && block.content?.length) {
      items.push({
        type: 'listItem',
        attrs: {
          nodeId: nextId(),
          nodeType: 'user',
          collapsed: false,
          bulletKind: 'bullet',
          completed: false,
        },
        content: [block],
      })
    }
  }
  const normalized = {
    type: 'doc',
    content: [{ type: 'bulletList', content: items.length ? items : [blankItem(nextId)] }],
  }
  return repairSystemNodes(normalized as Record<string, unknown>, nextId).doc as JsonValue
}

/** A fresh outline with canonical system roots and one ordinary editable bullet. */
export const EMPTY_DOC: JsonValue = normalizeOutlinerDoc({ type: 'doc' })
