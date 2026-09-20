import { Extension, type Editor } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { ExtensionSkillPreparedPlan } from '@forage/agent-runtime'
import type { ResolvedExtensionSkillContext } from '../agent/context'

interface ContextPreviewValue {
  localNodeIds?: string[]
  referencedNodeIds?: string[]
  candidateNodeIds?: string[]
  sharedNodeIds?: string[]
  excludedNodeIds?: string[]
  invocationNodeId: string
  annotations?: ExtensionSkillPreparedPlan['annotations']
  error?: string
}

const contextPreviewKey = new PluginKey<ContextPreviewValue | null>('skillContextPreview')
const contextPreviewMeta = 'setSkillContextPreview'

function decorations(doc: ProseMirrorNode, value: ContextPreviewValue | null) {
  if (!value) return DecorationSet.empty
  const local = new Set(value.localNodeIds ?? [])
  const referenced = new Set(value.referencedNodeIds ?? [])
  const candidates = new Set(value.candidateNodeIds ?? [])
  const shared = new Set(value.sharedNodeIds ?? [])
  const excluded = new Set(value.excludedNodeIds ?? [])
  const annotations = new Map<string, string[]>()
  for (const annotation of value.annotations ?? []) {
    const labels = annotations.get(annotation.nodeId) ?? []
    labels.push(annotation.label)
    annotations.set(annotation.nodeId, labels)
    if (annotation.kind === 'selected') candidates.add(annotation.nodeId)
    if (annotation.kind === 'shared') shared.add(annotation.nodeId)
    if (annotation.kind === 'excluded') excluded.add(annotation.nodeId)
  }
  const result: Decoration[] = []
  doc.descendants((node, pos) => {
    if (node.type.name !== 'listItem') return
    const nodeId = node.attrs.nodeId
    const classes: string[] = []
    if (local.has(nodeId)) classes.push('skill-context-local')
    if (referenced.has(nodeId)) classes.push('skill-context-reference')
    if (shared.has(nodeId)) classes.push('skill-context-shared')
    if (candidates.has(nodeId)) classes.push('skill-context-candidate')
    if (excluded.has(nodeId)) classes.push('skill-context-excluded')
    if (nodeId === value.invocationNodeId) classes.push('skill-context-invocation')
    if (value.error && nodeId === value.invocationNodeId) classes.push('skill-context-error')
    if (classes.length) {
      const annotationTitle = annotations.get(nodeId)?.join(' · ')
      result.push(Decoration.node(pos, pos + node.nodeSize, {
        class: classes.join(' '),
        ...(value.error && nodeId === value.invocationNodeId
          ? { title: `Context error: ${value.error}` }
          : annotationTitle ? { title: annotationTitle } : {}),
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

export function showExtensionSkillContext(
  editor: Editor,
  context: ResolvedExtensionSkillContext,
  plan?: Pick<ExtensionSkillPreparedPlan, 'annotations'>,
): void {
  showSkillContext(editor, {
    invocationNodeId: context.snapshot.invocation.id,
    localNodeIds: context.localNodeIds,
    referencedNodeIds: context.referencedNodeIds,
    ...(plan ? { annotations: plan.annotations } : {}),
  })
}

export function showSkillContextError(editor: Editor, invocationNodeId: string, error: string): void {
  showSkillContext(editor, {
    invocationNodeId, error,
  })
}

export function clearSkillContext(editor: Editor): void {
  if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(contextPreviewMeta, { value: null }))
}
