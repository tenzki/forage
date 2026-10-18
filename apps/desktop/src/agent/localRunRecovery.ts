import type { Editor } from '@tiptap/core'
import { isLocalAnswerResult, type RunInput } from '@forage/agent-runtime'
import type { ActivityReporter } from './activity'
import { fromRuntimeEvent, runActivityLabel } from './activityCalls'
import { documentEditor } from '../editor/documentAccess'
import { NativeEventRepository, type LocalAgentRunHistory } from '../persistence/eventStore'
import { useSettingsStore } from '../store/settingsStore'
import { useExtensionStore } from '../store/extensionStore'
import { useMcpStore } from '../store/mcpStore'
import { nativeLocalCredentialVault, resolveExtensionSecretValues, resolveLocalCredential } from './localCredentials'
import { createPiLocalRunner } from './piLocalRunner'
import { LocalAgentExecutor } from './localExecutor'
import { commitStructuredAgentResultInto, insertAiChildUnder, replaceAiOutput } from './insertIntoEditor'

const active = new Map<string, Promise<void>>()

/** Restart admitted local work against the canonical editor and the original immutable input. */
export async function recoverLocalAgentRuns(
  view: Editor,
  history: LocalAgentRunHistory[],
  options: {
    onActivity: ActivityReporter
    registerCancellation: (runId: string, cancel: (() => void) | null) => void
    acknowledgeEdits: () => Promise<void>
  },
): Promise<void> {
  const editor = documentEditor(view)
  for (const { run } of [...history].reverse()) {
    if (run.snapshot.version !== 1 || run.snapshot.runtime !== 'pi-durable' || run.cancelRequestedAt
      || !['queued', 'completed_unplaced'].includes(run.status)) continue
    if (run.status === 'queued' && run.errorCode !== 'desktop_restarted') continue
    if (active.has(run.id)) continue
    const work = recover(run.snapshot, run.result)
    active.set(run.id, work)
    void work.finally(() => { active.delete(run.id) }).catch(() => undefined)
  }
  await Promise.all([...active.values()])

  async function recover(input: RunInput, retained: LocalAgentRunHistory['run']['result']) {
    const runId = input.runId
    const label = runActivityLabel(input.skill.label, input.source.text ?? input.prompt)
    const notify = (phase: 'start' | 'complete' | 'error' | 'cancelled', extra: Record<string, unknown> = {}) => options.onActivity({
      id: runId, kind: 'skill', phase, label, nodeId: input.source.nodeId, thread: input.thread, ...extra,
    })
    try {
      const repository = new NativeEventRepository()
      let result = retained
      if (!result) {
        notify('start')
        const runner = createPiLocalRunner({
          resolveCredential: async (reference) => {
            const settings = useSettingsStore.getState()
            const credential = settings.localCredentials.find((candidate) => candidate.id === reference
              && candidate.provider === input.computeProfile?.provider && candidate.status === 'connected')
            if (!credential) throw new Error('The admitted local provider requires authentication. Repair Connection settings before retrying.')
            const auth = await resolveLocalCredential(credential, nativeLocalCredentialVault)
            return { ...auth, modelId: input.agent.modelId, onCredentialRefresh: settings.setOAuthCredential }
          },
          resolveMcpConnections: async (snapshot) => {
            if (!useMcpStore.getState().loaded) await useMcpStore.getState().load()
            return useMcpStore.getState().resolve(snapshot)
          },
          resolveExtensionSecrets: async (snapshot) => {
            if (!useExtensionStore.getState().configuration) await useExtensionStore.getState().refresh()
            const configuration = useExtensionStore.getState().configuration
            if (!configuration) throw new Error('The admitted extension configuration is unavailable.')
            return resolveExtensionSecretValues(snapshot, configuration, nativeLocalCredentialVault)
          },
        })
        const executor = new LocalAgentExecutor(repository, runner)
        const handle = await executor.resume(input, {
          onActivity: (event) => options.onActivity(fromRuntimeEvent(event, runId)),
          onDelta: (answer) => notify('start', { answer }),
        })
        options.registerCancellation(runId, () => { void handle.cancel() })
        result = await handle.completion
      }
      if (isLocalAnswerResult(result)) { notify('complete', { answer: result.text }); return }
      let target = false
      if (!editor.isDestroyed) editor.state.doc.descendants((node) => {
        if (node.type.name === 'listItem' && node.attrs.nodeId === input.target.parentId) target = true
      })
      if (!target || editor.isDestroyed) { notify('complete', { placementPending: true }); return }
      if ((input.thread?.turn ?? 1) > 1) replaceAiOutput(editor, input.target.parentId, runId, result)
      else {
        const outputId = `agent-output-${runId}`
        let exists = false
        editor.state.doc.descendants((node) => { if (node.attrs.nodeId === outputId) exists = true })
        if (!exists && !insertAiChildUnder(editor, input.target.parentId, outputId)) throw new Error('The result destination is unavailable.')
        commitStructuredAgentResultInto(editor, input.target.parentId, outputId, input.skill.label, result, runId)
      }
      // Native append atomically marks this result placed with its document event.
      await options.acknowledgeEdits()
      notify('complete', { placementPending: false })
    } catch (error) {
      notify(error instanceof DOMException && error.name === 'AbortError' ? 'cancelled' : 'error', {
        detail: error instanceof Error ? error.message : 'Local run recovery failed.',
        ...(retained ? { placementPending: true } : {}),
      })
    } finally { options.registerCancellation(runId, null) }
  }
}
