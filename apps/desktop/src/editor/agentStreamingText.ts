import { Extension, type Editor } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

export interface StreamingTextRange {
  from: number
  to: number
  delayMs?: number
}

const streamingTextKey = new PluginKey<DecorationSet>('agentStreamingText')

export const AgentStreamingText = Extension.create({
  name: 'agentStreamingText',

  addProseMirrorPlugins() {
    return [new Plugin<DecorationSet>({
      key: streamingTextKey,
      state: {
        init: () => DecorationSet.empty,
        apply: (transaction, current) => {
          const ranges = transaction.getMeta(streamingTextKey) as StreamingTextRange[] | undefined
          if (ranges) {
            return DecorationSet.create(transaction.doc, ranges
              .filter(({ from, to }) => from < to && from >= 0 && to <= transaction.doc.content.size)
              .map(({ from, to, delayMs = 0 }) => Decoration.inline(from, to, {
                class: 't-stream-w is-in',
                style: `--stream-delay:${Math.max(0, delayMs)}ms`,
              })))
          }
          return current.map(transaction.mapping, transaction.doc)
        },
      },
      props: {
        decorations: (state) => streamingTextKey.getState(state) ?? DecorationSet.empty,
      },
    })]
  },
})

export function showStreamingText(editor: Editor, ranges: StreamingTextRange[]): void {
  if (editor.isDestroyed) return
  editor.view.dispatch(editor.state.tr
    .setMeta(streamingTextKey, ranges)
    .setMeta('addToHistory', false)
    .setMeta('forageTransient', true))
}

export function clearStreamingText(editor: Editor): void {
  showStreamingText(editor, [])
}
