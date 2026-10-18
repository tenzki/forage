import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { getProviderModels } from '@forage/pi-runtime/provider-catalog'
import { sha256Hex } from '@forage/domain'
import type { McpConnection } from '@forage/agent-runtime'
import type { OutlineSession } from '../application/OutlineSession'
import { useSettingsStore } from '../store/settingsStore'
import { useExtensionStore } from '../store/extensionStore'
import { useMcpStore } from '../store/mcpStore'
import { appendChildBullet, collectBullets, findBullet } from '../editor/outlineModel'
import { documentEditor } from '../editor/documentAccess'
import { skillExecution, type SkillExecutionHandle } from '../agent/skillExecution'
import { isExtensionSkill } from '../agent/definitions'
import type { ActivityReporter } from '../agent/activity'
import { nativeLocalCredentialVault, resolveLocalCredential } from '../agent/localCredentials'
import { useOnboardingStore, type OnboardingStep } from './progress'

export function usableCompute() {
  const { localCompute: compute, localCredentials } = useSettingsStore.getState()
  return localCredentials.some((account) => account.id === compute.credentialRef && account.provider === compute.provider && account.status === 'connected')
    && getProviderModels(compute.provider).some((model) => model.id === compute.modelId)
}

export async function mcpReference(connection: McpConnection) {
  return { id: connection.id, fingerprint: await sha256Hex(JSON.stringify({ id: connection.id, revision: connection.authorizationRevision, tools: connection.tools.map(({ id, fingerprint, bindingFingerprint }) => ({ id, fingerprint, bindingFingerprint })) })) }
}

function invocationHasOutput(editor: Editor, id?: string) {
  let present = false
  if (id) findBullet(editor.state.doc, id)?.node.forEach(child => { if (child.type.name === 'bulletList' && child.childCount > 0) present = true })
  return present
}

async function credentialIsPresent() {
  const state = useSettingsStore.getState()
  const account = state.localCredentials.find(account => account.id === state.localCompute.credentialRef && account.provider === state.localCompute.provider)
  if (!account) return false
  try { await resolveLocalCredential(account, nativeLocalCredentialVault); return true } catch { return false }
}

export function useOnboarding(editor: Editor | null, session: OutlineSession, onActivity: ActivityReporter) {
  const { progress, busy, error: progressError, update } = useOnboardingStore()
  const active = progress?.status === 'in-progress' && session.getSnapshot().storageBackend.kind === 'local'
  const [error, setError] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const [running, setRunning] = useState(false)
  const [hasResult, setHasResult] = useState(false)
  const [prompt, setPrompt] = useState('/brainstorm Suggest a few ideas for this note')
  const [revision, setRevision] = useState(0)
  const operation = useRef(false)
  const run = useRef<SkillExecutionHandle | null>(null)
  const restoredInvocation = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (!editor) return
    const refresh = () => setRevision(value => value + 1)
    editor.on('update', refresh)
    return () => { editor.off('update', refresh) }
  }, [editor])
  useEffect(() => () => run.current?.cancel(), [])
  useEffect(() => { if (!progress?.runId) setHasResult(false) }, [progress?.runId])
  useEffect(() => {
    if (!editor || !progress?.invocationId || restoredInvocation.current === progress.invocationId) return
    const invocation = findBullet(documentEditor(editor).state.doc, progress.invocationId)
    if (!invocation) return
    restoredInvocation.current = progress.invocationId
    setPrompt(invocation.text.startsWith('/brainstorm') ? invocation.text : `/brainstorm ${invocation.text}`)
  }, [editor, progress?.invocationId])

  const act = async (action: () => Promise<void>) => {
    if (operation.current) return
    operation.current = true; setWorking(true); setError(null)
    try { await action() }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Setup could not be saved. Retry your action.') }
    finally { operation.current = false; setWorking(false) }
  }

  // Reconcile metadata against durable authorities. Never start external work here.
  const reconciled = useRef<string | null>(null)
  useEffect(() => {
    if (!active || !editor || !progress || working || reconciled.current === progress.outlineId) return
    reconciled.current = progress.outlineId ?? ''
    void act(async () => {
      const owner = documentEditor(editor)
      if (progress.outlineId !== session.context()?.outlineId || (progress.noteId && !findBullet(owner.state.doc, progress.noteId))) {
        await update({ step: 'note', outlineId: session.context()?.outlineId, noteId: undefined, invocationId: undefined, runId: undefined })
        setError('Your setup note is no longer available. Choose or write a note to continue.')
        return
      }
      if (progress.compute && (!usableCompute() || JSON.stringify(progress.compute) !== JSON.stringify(useSettingsStore.getState().localCompute) || !await credentialIsPresent())) {
        await update({ step: 'ai', compute: undefined })
        setError('Your saved AI selection is unavailable or changed. Confirm a connected provider and model, or skip for now.')
        return
      }
      if (progress.invocationId && !findBullet(owner.state.doc, progress.invocationId)) {
        await update({ step: 'command', invocationId: undefined, runId: undefined })
        setError('Your command is no longer available. Run a new command explicitly, or skip for now.')
        return
      }
      if (progress.runId) {
        const saved = await session.agentRun(progress.runId)
        const resultAvailable = saved?.status === 'completed' && Boolean(saved.result) && invocationHasOutput(owner, progress.invocationId)
        setHasResult(resultAvailable)
        if (!resultAvailable && !progress.skipped.includes('command')) {
          await update({ step: 'command' })
          setError('The previous command did not finish. Retry explicitly, or skip for now.')
          return
        }
      }
      const extensionState = useExtensionStore.getState()
      if (!extensionState.isLoaded) await extensionState.refresh()
      const entries = useExtensionStore.getState().catalog?.entries ?? []
      if (progress.extensions.some(reference => !entries.some(entry => entry.source.installationId === reference.installationId && entry.provenance?.sourceRevision === reference.revision))) {
        await update({ step: 'extensions' })
        setError('An extension source changed or is unavailable. Review its setup or skip for now.')
        return
      }
      if (progress.mcp.length) {
        if (!useMcpStore.getState().loaded) await useMcpStore.getState().load()
        const inventory = await Promise.all(useMcpStore.getState().connections.map(mcpReference))
        if (progress.mcp.some(reference => !inventory.some(entry => entry.id === reference.id && entry.fingerprint === reference.fingerprint))) {
          await update({ step: 'mcp' })
          setError('An MCP connection changed or is unavailable. Review the saved connections; tool permissions remain in Settings.')
        }
      }
    })
  }, [active, editor, progress, session, update, working])
  useEffect(() => { if (!active) reconciled.current = null }, [active])

  const note = editor && (progress?.noteId ? findBullet(editor.state.doc, progress.noteId) : collectBullets(editor.state.doc).find(bullet => bullet.systemRole === null && bullet.node.attrs.nodeType !== 'ai' && bullet.text.trim()))
  // Reading the editor revision keeps gating current after typing and undo.
  void revision
  const canContinueNote = Boolean(note?.text.trim())
  const resultVisible = hasResult && Boolean(editor && invocationHasOutput(editor, progress?.invocationId))
  const go = (step: OnboardingStep) => act(async () => { await session.acknowledgeEdits(); await update({ step }) })
  const skip = (step: 'ai' | 'command' | 'extensions' | 'mcp', next: OnboardingStep) => act(async () => {
    await session.acknowledgeEdits()
    await update({ step: next, skipped: [...new Set([...(progress?.skipped ?? []), step])] })
  })
  const continueNote = () => act(async () => {
    if (!note?.text.trim()) throw new Error('Write a note before continuing.')
    await session.acknowledgeEdits()
    await update({ noteId: note.id, step: 'ai' })
  })
  const confirmCompute = () => act(async () => {
    if (!await credentialIsPresent()) throw new Error('Your saved provider credential is unavailable. Reconnect it or skip for now.')
    await useSettingsStore.getState().selectLocalCompute(useSettingsStore.getState().localCompute)
    await update({ compute: { ...useSettingsStore.getState().localCompute }, step: 'command', skipped: (progress?.skipped ?? []).filter(step => step !== 'ai') })
  })
  const runCommand = () => act(async () => {
    if (running || !editor || !progress?.noteId || resultVisible) return
    if (!usableCompute() || JSON.stringify(progress.compute) !== JSON.stringify(useSettingsStore.getState().localCompute)) throw new Error('Confirm your AI provider and model before running a command.')
    const match = /^\/brainstorm(?:\s+(.*))?$/su.exec(prompt.trim())
    if (!match) throw new Error('Start your request with /brainstorm.')
    const skill = useSettingsStore.getState().skills.find(skill => skill.label === 'brainstorm' && !isExtensionSkill(skill))
    if (!skill) throw new Error('The /brainstorm skill is unavailable. Restore or configure it in Settings, or skip for now.')
    const owner = documentEditor(editor)
    let invocationId = progress.invocationId
    if (!invocationId) {
      invocationId = appendChildBullet(editor, progress.noteId, prompt.trim()) ?? undefined
      if (!invocationId) throw new Error('Your note is unavailable. Return to the first step.')
      await session.acknowledgeEdits()
      await update({ invocationId })
    } else {
      const invocation = findBullet(owner.state.doc, invocationId)
      if (!invocation) throw new Error('Your command is unavailable. Return to the note step.')
      const paragraph = invocation.node.firstChild!
      owner.view.dispatch(owner.state.tr.replaceWith(invocation.pos + 2, invocation.pos + 2 + paragraph.content.size, owner.schema.text(prompt.trim())))
      await session.acknowledgeEdits()
    }
    setRunning(true)
    let failure: string | null = null
    const handle = skillExecution.execute({ editor: owner, skillId: skill.id, invocationNodeId: invocationId, prompt: match[1] ?? '' }, {
      onError: message => { failure = message; setError(message) }, onActivity,
    })
    run.current = handle
    try {
      try { await update({ runId: handle.runId }) }
      catch (cause) { handle.cancel(); await handle.completion; throw cause }
      await handle.completion
      await session.acknowledgeEdits()
      const saved = await session.agentRun(handle.runId)
      const completed = !failure && saved?.status === 'completed' && Boolean(saved.result) && invocationHasOutput(owner, invocationId)
      setHasResult(completed)
      if (!completed && !failure) setError('The command was canceled or interrupted. Retry explicitly, or skip for now.')
    } finally { run.current = null; setRunning(false) }
  })
  const finish = (status: 'completed' | 'paused' | 'skipped') => act(async () => {
    await session.acknowledgeEdits()
    await update({ status })
  })
  return { active, progress, busy: busy || working, running, error: progressError ?? error, hasResult: resultVisible, prompt, setPrompt, canContinueNote, note, go, skip, continueNote, confirmCompute, runCommand, cancelRun: () => run.current?.cancel(), finish, act }
}
export type OnboardingController = ReturnType<typeof useOnboarding>
