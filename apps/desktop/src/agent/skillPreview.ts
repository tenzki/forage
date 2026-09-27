import type { Editor } from '@tiptap/core'
import { isExtensionSkill, type SkillDefinition } from './definitions'
import { resolveAgentContext, resolveExtensionSkillContext } from './context'
import { prepareExtensionSkillInvocation, selectedExtensionExecutor } from './extensionSkillInvocation'
import { extensionExecutorOptions, useExtensionStore } from '../store/extensionStore'
import { useSettingsStore } from '../store/settingsStore'
import { showExtensionSkillContext, showSkillContext, showSkillContextError } from '../editor/contextPreview'

export function skillInvocationPrompt(skill: SkillDefinition, prompt: string | undefined): string {
  return (isExtensionSkill(skill) ? (prompt ?? '') : (prompt || skill.label)).trim()
}

export function skillAllowsEmptyPrompt(skill: SkillDefinition, catalog = useExtensionStore.getState().catalog): boolean {
  if (!isExtensionSkill(skill)) return false
  return extensionExecutorOptions(catalog).some((option) => (
    option.available && option.allowEmptyPrompt
    && option.extensionId === skill.executor.extensionId
    && option.executorId === skill.executor.executorId
  ))
}

/** Preview preparation stays behind the same application boundary as execution.
 * Returning cancellation lets any invoking surface discard stale previews.
 */
export function previewSkillContext(
  request: { editor: Editor; skillId: string; invocationNodeId: string; prompt: string },
  onError: (message: string | null) => void,
): () => void {
  const { editor, invocationNodeId } = request
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const fail = (error: unknown) => {
    if (controller.signal.aborted || editor.isDestroyed) return
    const detail = error instanceof Error ? error.message : String(error)
    onError(detail)
    showSkillContextError(editor, invocationNodeId, detail)
  }
  try {
    const skill = useSettingsStore.getState().skills.find((candidate) => candidate.id === request.skillId)
    if (!skill) throw new Error('The selected skill no longer exists.')
    if (isExtensionSkill(skill)) {
      const { catalog, configuration } = useExtensionStore.getState()
      const option = selectedExtensionExecutor(skill, catalog)
      const prompt = skillInvocationPrompt(skill, request.prompt)
      const context = resolveExtensionSkillContext(editor.state.doc, invocationNodeId, prompt)
      showExtensionSkillContext(editor, context)
      onError(null)
      if (prompt || option.allowEmptyPrompt) {
        if (!catalog || !configuration) throw new Error('Local extension inventory is unavailable; open Extensions settings and retry.')
        timer = setTimeout(() => {
          void prepareExtensionSkillInvocation({
            skill, prompt, doc: editor.state.doc, invocationNodeId,
            catalog, localConfiguration: configuration,
            portableConfigurationRevision: 0, runId: crypto.randomUUID(), signal: controller.signal,
          }).then(async (prepared) => {
            try {
              if (!controller.signal.aborted && !editor.isDestroyed) showExtensionSkillContext(editor, prepared.context, prepared.admission.plan)
            } finally { await prepared.admission.release() }
          }).catch(fail)
        }, 150)
      }
    } else {
      showSkillContext(editor, resolveAgentContext(editor.state.doc, invocationNodeId))
      onError(null)
    }
  } catch (error) { fail(error) }
  return () => { controller.abort(); if (timer) clearTimeout(timer) }
}
