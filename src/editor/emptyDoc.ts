import type { JsonValue } from '../types/tree'

/** A fresh outline: one empty bullet. nodeId is filled in by BulletAttributes. */
export const EMPTY_DOC: JsonValue = {
  type: 'doc',
  content: [
    {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          attrs: { nodeType: 'user' },
          content: [{ type: 'paragraph' }],
        },
      ],
    },
  ],
}
