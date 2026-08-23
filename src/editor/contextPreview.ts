import { Extension, type Editor } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { Plugin, PluginKey } from '@tiptap/pm/state'

interface ContextPreviewValue {
  nodeIds: string[]
  anchorNodeId: string
  invocationNodeId: string
  truncated: boolean
  error?: string
}

const contextPreviewKey = new PluginKey<ContextPreviewValue | null>('skillContextPreview')
const contextPreviewMeta = 'setSkillContextPreview'

function decorations(doc: ProseMirrorNode, value: ContextPreviewValue | null) {
  if (!value) return DecorationSet.empty
  const included = new Set(value.nodeIds)
  const result: Decoration[] = []
  doc.descendants((node, pos) => {
    if (node.type.name !== 'listItem') return
    const nodeId = node.attrs.nodeId
    const classes: string[] = []
    if (included.has(nodeId)) classes.push('skill-context-included')
    if (nodeId === value.anchorNodeId) classes.push('skill-context-anchor')
    if (nodeId === value.invocationNodeId) classes.push('skill-context-invocation')
    if (value.truncated && included.has(nodeId)) classes.push('skill-context-truncated')
    if (value.error && nodeId === value.invocationNodeId) classes.push('skill-context-error')
    if (classes.length) {
      result.push(Decoration.node(pos, pos + node.nodeSize, {
        class: classes.join(' '),
        ...(value.error && nodeId === value.invocationNodeId ? { title: `Context error: ${value.error}` } : {}),
      }))
    }
  })
  return DecorationSet.create(doc, result)
}

export const SkillContextPreview = Extension.create({
  name: 'skillContextPreview',

  addProseMirrorPlugins() {
    return [new Plugin<ContextPreviewValue | null>({
      key: contextPreviewKey,
      state: {
        init: () => null,
        apply: (transaction, previous) => {
          const meta = transaction.getMeta(contextPreviewMeta) as { value: ContextPreviewValue | null } | undefined
          return meta ? meta.value : previous
        },
      },
      props: {
        decorations: (state) => decorations(state.doc, contextPreviewKey.getState(state) ?? null),
      },
    })]
  },
})

export function showSkillContext(editor: Editor, value: ContextPreviewValue): void {
  if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(contextPreviewMeta, { value }))
}

export function showSkillContextError(editor: Editor, invocationNodeId: string, error: string): void {
  showSkillContext(editor, {
    nodeIds: [], anchorNodeId: invocationNodeId, invocationNodeId, truncated: false, error,
  })
}

export function clearSkillContext(editor: Editor): void {
  if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(contextPreviewMeta, { value: null }))
}
