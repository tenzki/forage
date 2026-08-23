import { Extension, type Editor } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

interface ContextPreviewValue {
  localNodeIds: string[]
  referencedNodeIds: string[]
  invocationNodeId: string
  error?: string
}

const contextPreviewKey = new PluginKey<ContextPreviewValue | null>('skillContextPreview')
const contextPreviewMeta = 'setSkillContextPreview'

function decorations(doc: ProseMirrorNode, value: ContextPreviewValue | null) {
  if (!value) return DecorationSet.empty
  const local = new Set(value.localNodeIds)
  const referenced = new Set(value.referencedNodeIds)
  const result: Decoration[] = []
  doc.descendants((node, pos) => {
    if (node.type.name !== 'listItem') return
    const nodeId = node.attrs.nodeId
    const classes: string[] = []
    if (local.has(nodeId)) classes.push('skill-context-local')
    if (referenced.has(nodeId)) classes.push('skill-context-reference')
    if (nodeId === value.invocationNodeId) classes.push('skill-context-invocation')
    if (value.error && nodeId === value.invocationNodeId) classes.push('skill-context-error')
    if (classes.length) {
      result.push(Decoration.node(pos, pos + node.nodeSize, {
        class: classes.join(' '),
        ...(value.error && nodeId === value.invocationNodeId
          ? { title: `Context error: ${value.error}` }
          : {}),
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
    localNodeIds: [], referencedNodeIds: [], invocationNodeId, error,
  })
}

export function clearSkillContext(editor: Editor): void {
  if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(contextPreviewMeta, { value: null }))
}
