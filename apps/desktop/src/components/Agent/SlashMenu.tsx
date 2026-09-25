// Slash-command menu. When the current bullet's text starts with "/", show
// matching skills and local outline commands near the caret. Selecting a skill
// completes "/skill " so the user can add a prompt; Enter then runs it.

import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { isExtensionSkill, type SkillDefinition } from '../../agent/definitions'
import { resolveAgentContext, resolveExtensionSkillContext, resolveFollowUpContext } from '../../agent/context'
import {
  commitExtensionSkillResult,
  commitStructuredAgentResultInto,
  currentListItemId,
  insertAiChildUnder,
  removeAiList,
  replaceAiOutput,
  setCurrentBulletText,
  writeAiText,
} from '../../agent/insertIntoEditor'
import { focusOrCreateBulletNote } from '../../editor/bulletNote'
import { activeInternalLinkAtSelection } from '../../editor/internalLinks'
import {
  OUTLINE_COMMANDS,
  type OutlineCommandDefinition,
} from '../../editor/commandDefinitions'
import { clearSkillContext, showExtensionSkillContext, showSkillContext, showSkillContextError } from '../../editor/contextPreview'
import {
  currentBulletId,
  setBulletKind,
  setTodoCompleted,
} from '../../editor/outlineModel'
import { useSettingsStore } from '../../store/settingsStore'
import type { ActivityReporter } from '../../agent/activity'
import { fromRuntimeEvent, runActivityLabel } from '../../agent/activityCalls'
import {
  OUTLINE_RUN_SKILL_EVENT,
  recordReplacedOutput,
  type SkillRunConversation,
  type SkillRunRequest,
  type SkillRunSteering,
} from '../../agent/skillRuns'
import {
  nativeLocalCredentialVault,
  resolveExtensionExecutorSecretValues,
  resolveExtensionSecretValues,
  resolveLocalCredential,
} from '../../agent/localCredentials'
import { NativeEventRepository } from '../../persistence/eventStore'
import { LocalAgentExecutor } from '../../agent/localExecutor'
import { serverRunManager } from '../../agent/serverRunManager'
import { createPiLocalRunner } from '../../agent/piLocalRunner'
import { buildOutlineSnapshot } from '../../agent/outlineSnapshot'
import { BUILTIN_TOOL_OPTIONS } from '../../agent/tools'
import { setAgentActivity } from '../../editor/outlinerUi'
import {
  assertExtensionExecutionLocation,
  prepareExtensionSkillInvocation,
  retainPreparedExtensionSkillResult,
  selectedExtensionExecutor,
} from '../../agent/extensionSkillInvocation'
import {
  createLocalExtensionSnapshotFromCatalog,
  isLocalAnswerResult,
  resolveEffectiveToolIds,
  type ActivityEvent as RuntimeActivityEvent,
  type RunInput,
} from '@forage/agent-runtime'
import { extensionExecutorOptions, extensionToolOptions, useExtensionStore } from '../../store/extensionStore'

interface CommandChoice {
  id: string
  label: string
  description: string
  skill?: SkillDefinition
  outlineCommand?: OutlineCommandDefinition
}

interface MenuState {
  query: string
  prompt: string
  top: number
  left: number
}

function commandChoices(skills: SkillDefinition[]): CommandChoice[] {
  return [
    ...OUTLINE_COMMANDS.map((outlineCommand) => ({
      ...outlineCommand,
      outlineCommand,
    })),
    ...skills.map((skill) => ({
      id: skill.id,
      label: skill.label,
      description: skill.description,
      skill,
    })),
  ]
}

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

function runOutlineCommand(editor: Editor, command: OutlineCommandDefinition): void {
  const nodeId = currentBulletId(editor)
  if (!nodeId) return
  if (command.id === 'note') {
    focusOrCreateBulletNote(editor, nodeId)
  } else if (command.id === 'bullet') {
    setBulletKind(editor, nodeId, 'bullet')
  } else {
    setTodoCompleted(editor, nodeId, command.id === 'done')
  }
}

function readSlashState(editor: Editor): MenuState | null {
  const { $from, empty } = editor.state.selection
  if (!empty) return null
  let text = ''
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name === 'listItem') {
      text = $from.node(depth).firstChild?.textContent ?? ''
      break
    }
  }
  if (!text.startsWith('/')) return null
  const body = text.slice(1)
  const spaceIndex = body.indexOf(' ')
  const query = spaceIndex === -1 ? body : body.slice(0, spaceIndex)
  const prompt = spaceIndex === -1 ? '' : body.slice(spaceIndex + 1)
  const coords = editor.view.coordsAtPos($from.pos)
  return { query, prompt, top: coords.bottom + 4, left: coords.left }
}

export function SlashMenu({
  editor,
  onError,
  onActivity,
  onBeforeServerRun,
  onAfterServerRun,
  onRegisterExtensionCancellation,
}: {
  editor: Editor | null
  onError: (message: string | null) => void
  onActivity?: ActivityReporter
  onBeforeServerRun?: () => Promise<void>
  onAfterServerRun?: () => Promise<void>
  onRegisterExtensionCancellation?: (runId: string, cancel: (() => void) | null) => void
}) {
  const authMode = useSettingsStore((state) => state.authMode)
  const localCredentials = useSettingsStore((state) => state.localCredentials)
  const modelId = useSettingsStore((state) => state.modelId)
  const enabledToolIds = useSettingsStore((state) => state.enabledToolIds)
  const customTools = useSettingsStore((state) => state.customTools)
  const agents = useSettingsStore((state) => state.agents)
  const skills = useSettingsStore((state) => state.skills)
  const setOAuthCredential = useSettingsStore((state) => state.setOAuthCredential)
  const extensionCatalog = useExtensionStore((state) => state.catalog)
  const extensionConfiguration = useExtensionStore((state) => state.configuration)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [active, setActive] = useState(0)
  const [completedCommand, setCompletedCommand] = useState<CommandChoice | null>(null)
  const [contextError, setContextError] = useState<string | null>(null)
  const completedCommandRef = useRef<CommandChoice | null>(null)
  const choices = commandChoices(skills)
  const matches = menu
    ? choices.filter((command) => command.label.startsWith(menu.query))
    : []

  useEffect(() => {
    if (!editor) return
    const update = () => {
      const state = readSlashState(editor)
      const completed = completedCommandRef.current
      if (completed && state?.query === completed.label) {
        setMenu(null)
        return
      }
      if (completed) {
        completedCommandRef.current = null
        setCompletedCommand(null)
      }
      setMenu(state)
      setActive(0)
    }
    editor.on('selectionUpdate', update)
    editor.on('update', update)
    return () => {
      editor.off('selectionUpdate', update)
      editor.off('update', update)
    }
  }, [editor])

  useEffect(() => {
    if (!editor) return
    let previewController: AbortController | null = null
    let previewTimer: ReturnType<typeof setTimeout> | null = null
    const refresh = () => {
      previewController?.abort()
      previewController = null
      if (previewTimer) clearTimeout(previewTimer)
      previewTimer = null
      const state = readSlashState(editor)
      const invocationNodeId = currentListItemId(editor)
      if (!editor.isFocused || !state || !invocationNodeId) {
        setContextError(null)
        clearSkillContext(editor)
        return
      }
      const candidates = commandChoices(skills)
        .filter((command) => command.label.startsWith(state.query))
      const command = completedCommandRef.current?.label === state.query
        ? completedCommandRef.current
        : candidates[active] ?? candidates[0]
      if (!command?.skill) {
        setContextError(null)
        clearSkillContext(editor)
        return
      }
      try {
        if (isExtensionSkill(command.skill)) {
          const extensionSkill = command.skill
          const option = selectedExtensionExecutor(extensionSkill, extensionCatalog)
          const prompt = skillInvocationPrompt(extensionSkill, state.prompt)
          if (!prompt && !option.allowEmptyPrompt) {
            showExtensionSkillContext(editor, resolveExtensionSkillContext(editor.state.doc, invocationNodeId, prompt))
            setContextError(null)
            return
          }
          if (!extensionCatalog || !extensionConfiguration) throw new Error('Local extension inventory is unavailable; open Extensions settings and retry.')
          const context = resolveExtensionSkillContext(editor.state.doc, invocationNodeId, prompt)
          showExtensionSkillContext(editor, context)
          setContextError(null)
          previewController = new AbortController()
          const signal = previewController.signal
          previewTimer = setTimeout(() => {
            void prepareExtensionSkillInvocation({
              skill: extensionSkill, prompt, doc: editor.state.doc, invocationNodeId,
              catalog: extensionCatalog, localConfiguration: extensionConfiguration,
              portableConfigurationRevision: 0, runId: crypto.randomUUID(), signal,
            }).then(async (prepared) => {
              if (!signal.aborted && !editor.isDestroyed) showExtensionSkillContext(editor, prepared.context, prepared.admission.plan)
              await prepared.admission.release()
            }).catch((error) => {
              if (signal.aborted || editor.isDestroyed) return
              const detail = error instanceof Error ? error.message : String(error)
              setContextError(detail)
              showSkillContextError(editor, invocationNodeId, detail)
            })
          }, 150)
          return
        }
        showSkillContext(editor, resolveAgentContext(editor.state.doc, invocationNodeId))
        setContextError(null)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        setContextError(detail)
        showSkillContextError(editor, invocationNodeId, detail)
      }
    }
    const blur = () => {
      setContextError(null)
      clearSkillContext(editor)
    }
    refresh()
    editor.on('selectionUpdate', refresh)
    editor.on('update', refresh)
    editor.on('focus', refresh)
    editor.on('blur', blur)
    return () => {
      previewController?.abort()
      if (previewTimer) clearTimeout(previewTimer)
      editor.off('selectionUpdate', refresh)
      editor.off('update', refresh)
      editor.off('focus', refresh)
      editor.off('blur', blur)
      clearSkillContext(editor)
    }
  }, [editor, skills, menu, completedCommand, active, extensionCatalog, extensionConfiguration])

  useEffect(() => {
    if (!editor || !menu || matches.length === 0) return
    const onKey = (event: KeyboardEvent) => {
      const command = matches[active] ?? matches[0]
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActive((index) => (index + 1) % matches.length)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActive((index) => (index - 1 + matches.length) % matches.length)
      } else if (event.key === 'Tab' && !event.shiftKey) {
        if (activeInternalLinkAtSelection(editor.state)) return
        event.preventDefault()
        complete(command)
      } else if (event.key === 'Enter') {
        if (activeInternalLinkAtSelection(editor.state)) return
        event.preventDefault()
        const hasPrompt = menu.query === command.label && menu.prompt.trim().length > 0
        const allowsEmptyPrompt = command.skill && skillAllowsEmptyPrompt(command.skill) && menu.query === command.label
        if (command.outlineCommand || hasPrompt || allowsEmptyPrompt || event.metaKey || event.ctrlKey) run(command)
        else complete(command)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        setMenu(null)
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [editor, menu, matches, active])

  useEffect(() => {
    if (!editor || !completedCommand) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
      if (activeInternalLinkAtSelection(editor.state)) return
      const state = readSlashState(editor)
      if (state?.query !== completedCommand.label) return
      event.preventDefault()
      run(completedCommand)
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [editor, completedCommand])

  function complete(command: CommandChoice): void {
    if (!editor) return
    const prompt = menu?.prompt.trimStart() ?? ''
    const text = `/${command.label}${prompt ? ` ${prompt}` : ' '}`
    completedCommandRef.current = command
    setCompletedCommand(command)
    setCurrentBulletText(editor, text, true)
    setMenu(null)
    editor.view.focus()
  }

  function run(command: CommandChoice): void {
    if (!editor) return
    const state = readSlashState(editor)
    const context = state?.query === command.label ? state.prompt : menu?.prompt
    const prompt = command.skill ? skillInvocationPrompt(command.skill, context) : (context ?? '').trim()
    completedCommandRef.current = null
    setCompletedCommand(null)
    if (command.outlineCommand) {
      const activityId = `command-${Date.now()}`
      const commandNodeId = currentListItemId(editor)
      const commandLabel = `/${command.outlineCommand.label}`
      const nodeId = commandNodeId ? { nodeId: commandNodeId } : {}
      onActivity?.({ id: activityId, phase: 'start', kind: 'command', label: commandLabel, ...nodeId })
      clearSkillContext(editor)
      setCurrentBulletText(editor, prompt)
      setMenu(null)
      runOutlineCommand(editor, command.outlineCommand)
      onActivity?.({ id: activityId, phase: 'complete', kind: 'command', label: commandLabel, ...nodeId })
      return
    }
    const skill = command.skill
    if (!skill) return
    const invocationNodeId = currentListItemId(editor)
    if (!invocationNodeId) {
      onError('Could not find the skill invocation bullet.')
      return
    }
    runSkill(skill, prompt, invocationNodeId)
  }

  /**
   * Run `skill` for the bullet `invocationNodeId`. `steering` marks a follow-up
   * iteration: the call keeps its original label and records the user's note.
   * `conversation` continues a local call's agent conversation; without it, a
   * local run starts a new conversation of its own.
   */
  function runSkill(
    skill: SkillDefinition,
    prompt: string,
    invocationNodeId: string,
    steering?: SkillRunSteering,
    conversation?: SkillRunConversation,
  ): void {
    if (!editor) return
    if (isExtensionSkill(skill)) {
      const runId = crypto.randomUUID()
      const controller = new AbortController()
      const callLabel = runActivityLabel(skill.label, prompt)
      onRegisterExtensionCancellation?.(runId, () => controller.abort(new DOMException('Extension skill cancelled by the user.', 'AbortError')))
      onError(null)
      onActivity?.({ id: runId, phase: 'start', kind: 'skill', label: callLabel, nodeId: invocationNodeId, ...(prompt ? { detail: prompt } : {}) })
      void (async () => {
        const startedAt = Date.now()
        const repository = new NativeEventRepository()
        let prepared: Awaited<ReturnType<typeof prepareExtensionSkillInvocation>> | null = null
        try {
          assertExtensionExecutionLocation(await repository.storageMode())
          if (!extensionCatalog || !extensionConfiguration) await useExtensionStore.getState().refresh()
          const current = useExtensionStore.getState()
          prepared = await prepareExtensionSkillInvocation({
            skill, prompt, doc: editor.state.doc, invocationNodeId,
            catalog: current.catalog, localConfiguration: current.configuration,
            portableConfigurationRevision: 0, runId, signal: controller.signal,
          })
          showExtensionSkillContext(editor, prepared.context, prepared.admission.plan)
          const identity = await repository.identity()
          const activeConfiguration = useExtensionStore.getState().configuration
          if (!activeConfiguration) throw new Error('Extension configuration is unavailable; refresh Extensions settings and retry.')
          const secrets = await resolveExtensionExecutorSecretValues(
            prepared.admission.executorSnapshot,
            activeConfiguration,
            nativeLocalCredentialVault,
          )
          let logSequence = 0
          const result = await retainPreparedExtensionSkillResult(prepared, {
            repository,
            runId,
            outlineId: identity.outlineId,
            invocationNodeId,
            secrets,
            signal: controller.signal,
            onProgress: (progress) => onActivity?.({
              id: `progress-${runId}`,
              callId: runId,
              phase: 'start',
              kind: 'thinking',
              label: progress.message,
              ...(progress.completed === undefined ? {} : {
                detail: progress.total === undefined
                  ? `${progress.completed} complete`
                  : `${progress.completed} of ${progress.total} complete`,
              }),
              nodeId: invocationNodeId,
            }),
            onLog: (entry) => {
              if (entry.level === 'debug') return
              logSequence += 1
              onActivity?.({
                id: `extension-log-${runId}-${logSequence}`,
                callId: runId,
                phase: entry.level === 'error' ? 'error' : 'complete',
                kind: entry.level === 'error' ? 'error' : 'thinking',
                label: entry.message,
                nodeId: invocationNodeId,
              })
            },
          })
          let resultNodeIds: string[] = []
          try {
            resultNodeIds = commitExtensionSkillResult(
              editor,
              invocationNodeId,
              skill.label,
              runId,
              result,
              prepared.admission.plan.admittedReferenceIds,
            )
            await repository.placeAgentRunResult(runId, new Date().toISOString())
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            onActivity?.({
              id: runId,
              phase: 'complete',
              kind: 'skill',
              label: callLabel,
              detail,
              nodeId: invocationNodeId,
              placementPending: true,
              durationMs: Date.now() - startedAt,
            })
            onActivity?.({
              id: `placement-${runId}`,
              callId: runId,
              phase: 'complete',
              kind: 'output',
              label: 'Result retained — select a bullet and choose Place here',
              detail,
            })
            onError('The extension result was retained because placement could not be finalized.')
            return
          }
          const resultNodeId = resultNodeIds[0]
          if (resultNodeId) {
            onActivity?.({
              id: `outline-${runId}`,
              callId: runId,
              phase: 'complete',
              kind: 'output',
              label: 'Outline updated',
              nodeId: resultNodeId,
            })
          }
          onActivity?.({
            id: runId,
            phase: 'complete',
            kind: 'skill',
            label: callLabel,
            nodeId: invocationNodeId,
            placementPending: false,
            durationMs: Date.now() - startedAt,
          })
          clearSkillContext(editor)
          setContextError(null)
        } finally {
          await prepared?.admission.release()
          onRegisterExtensionCancellation?.(runId, null)
        }
      })().catch((error) => {
        const detail = error instanceof Error ? error.message : String(error)
        const cancelled = controller.signal.aborted
          || (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError')
        onActivity?.({
          id: runId,
          phase: cancelled ? 'cancelled' : 'error',
          kind: 'skill',
          label: callLabel,
          ...(cancelled ? {} : { detail }),
          nodeId: invocationNodeId,
        })
        if (cancelled) {
          onError(null)
          clearSkillContext(editor)
          setContextError(null)
        } else {
          onError(detail)
          showSkillContextError(editor, invocationNodeId, detail)
          setContextError(detail)
        }
      })
      setMenu(null)
      return
    }
    const agent = agents.find((candidate) => candidate.id === skill.agentId)
    if (!agent) {
      onError(`The agent assigned to /${skill.label} no longer exists.`)
      return
    }
    onError(null)
    // A reply resumes the call's conversation; its outline changes only if it ends with a revision.
    const followUp = Boolean(conversation && conversation.turn > 1)
    const contextSnapshot = followUp ? null : resolveAgentContext(editor.state.doc, invocationNodeId)
    const repository = new NativeEventRepository()
    // One call id per run keeps every event of this invocation in a single sidebar group.
    const runId = crypto.randomUUID()
    const startedAt = Date.now()
    const callLabel = runActivityLabel(skill.label, steering?.basePrompt ?? prompt)
    let localOutputNodeId: string | null = null
    onActivity?.({
      id: runId,
      phase: 'start',
      kind: 'skill',
      label: callLabel,
      nodeId: invocationNodeId,
      ...(prompt ? { detail: steering?.basePrompt ?? prompt } : {}),
      ...(steering ? { note: steering.note } : {}),
    })
    void (async () => {
      const followUpContext = followUp ? resolveFollowUpContext(editor.state.doc, invocationNodeId) : null
      const context = followUpContext?.context ?? contextSnapshot!
      const mode = await repository.storageMode()
      if (mode === 'server' && conversation) {
        throw new Error('This conversation is stored on this device. Switch back to local mode to reply to it.')
      }
      if (mode === 'server') {
        await onBeforeServerRun?.()
        const connection = await repository.serverConnection()
        if (!connection) throw new Error('Server mode is not configured.')
        const sync = await repository.syncState(connection.outlineId)
        const handle = await serverRunManager.invoke({
          version: 2, invocationId: runId, sourceNodeId: invocationNodeId,
          skillId: skill.id, prompt: prompt || skill.label,
          acknowledgedOutlineRevision: sync.lastPulledRevision,
        }, (event) => onActivity?.(fromRuntimeEvent(event, runId)))
        onRegisterExtensionCancellation?.(runId, () => void handle.cancel())
        const completed = await handle.completion.finally(() => onRegisterExtensionCancellation?.(runId, null))
        if (completed.status === 'completed_unplaced') {
          onActivity?.({
            id: `placement-${runId}`, callId: runId, phase: 'error', kind: 'output',
            label: 'Result needs a destination',
            detail: 'The bullet this run wrote to was removed. The output is kept on the server.',
            nodeId: invocationNodeId,
          })
        } else {
          await onAfterServerRun?.()
          onActivity?.({
            id: `outline-${runId}`, callId: runId, phase: 'complete', kind: 'output',
            label: 'Outline updated', nodeId: invocationNodeId,
          })
        }
        onActivity?.({ id: runId, phase: 'complete', kind: 'skill', label: callLabel, nodeId: invocationNodeId, durationMs: Date.now() - startedAt })
        return
      }

      const provider = authMode === 'subscription' ? 'openai-codex' : 'openai'
      const credential = localCredentials.find((candidate) => candidate.provider === provider && candidate.status === 'connected')
      if (!credential) throw new Error(authMode === 'subscription'
        ? 'Not signed in to ChatGPT. Open Settings and connect your subscription.'
        : 'No OpenAI API key set. Open Settings and add your API key.')
      const identity = await repository.identity()
      if (!extensionCatalog || !extensionConfiguration) {
        await useExtensionStore.getState().refresh()
      }
      const currentExtensionState = useExtensionStore.getState()
      if (!currentExtensionState.catalog || !currentExtensionState.configuration) {
        throw new Error('Local extension inventory is unavailable; open Extensions settings and retry.')
      }
      const supportedExtensionToolIds = extensionToolOptions(currentExtensionState.catalog)
        .filter((tool) => tool.available)
        .map((tool) => tool.id)
      const effectiveToolIds = resolveEffectiveToolIds({
        agentToolIds: agent.toolIds, requiredToolIds: skill.requiredToolIds,
        globallyEnabledToolIds: enabledToolIds, policyAllowedToolIds: agent.toolIds,
        executorSupportedToolIds: [
          ...BUILTIN_TOOL_OPTIONS.map((tool) => tool.id),
          ...customTools.map((tool) => tool.id),
          ...supportedExtensionToolIds,
        ],
      })
      const localExtensionSnapshot = createLocalExtensionSnapshotFromCatalog(
        currentExtensionState.catalog,
        currentExtensionState.configuration.revision,
        effectiveToolIds,
      )
      const thread = conversation
        ? { callId: conversation.callId, turn: conversation.turn }
        : { callId: runId, turn: 1 }
      const input: RunInput = {
        version: 1, runId, executionMode: 'local', outlineId: identity.outlineId,
        // A reply's prompt is the reply; its source text keeps the call's first prompt.
        source: { nodeId: invocationNodeId, text: followUp ? steering?.basePrompt ?? '' : prompt },
        target: { parentId: invocationNodeId },
        baseRevision: 0, configurationRevision: 0, credentialRef: credential.id,
        agent: { ...agent, modelId }, skill, effectiveToolIds, prompt: prompt || skill.label, context: context.lines,
        customTools, outlineSnapshot: JSON.stringify(buildOutlineSnapshot(editor.state.doc)),
        ...(localExtensionSnapshot ? { localExtensionSnapshot } : {}),
        thread,
        ...(followUpContext ? { invocationOutline: followUpContext.invocationOutline } : {}),
      }
      onActivity?.({ id: runId, phase: 'start', kind: 'skill', label: callLabel, nodeId: invocationNodeId, thread })
      const runner = createPiLocalRunner({
        resolveCredential: async (reference) => {
          if (reference !== credential.id) throw new Error('The local credential reference changed before execution.')
          const auth = await resolveLocalCredential(credential, nativeLocalCredentialVault)
          return { ...auth, modelId, onCredentialRefresh: setOAuthCredential }
        },
        resolveExtensionSecrets: async (snapshot) => {
          const configuration = useExtensionStore.getState().configuration
          if (!configuration) throw new Error('Extension configuration is unavailable; refresh Extensions settings and retry.')
          return resolveExtensionSecretValues(snapshot, configuration, nativeLocalCredentialVault)
        },
      })
      if (!followUp) {
        localOutputNodeId = insertAiChildUnder(editor, invocationNodeId)
        if (!localOutputNodeId) throw new Error('Could not create live agent output.')
        setAgentActivity(editor, localOutputNodeId, ['Thinking…'])
      }
      let streamedText = ''
      const handle = await new LocalAgentExecutor(repository, runner).invoke(input, {
        onActivity: (event) => onActivity?.(fromRuntimeEvent(event, runId)),
        onDelta: (nextText) => {
          // A reply streams into the call's thread until its outcome is known.
          if (followUp) {
            onActivity?.({ id: runId, phase: 'start', kind: 'skill', label: callLabel, nodeId: invocationNodeId, answer: nextText })
            return
          }
          if (!localOutputNodeId) return
          setAgentActivity(editor, localOutputNodeId, [])
          writeAiText(editor, localOutputNodeId, nextText, streamedText)
          streamedText = nextText
        },
      })
      onRegisterExtensionCancellation?.(runId, () => void handle.cancel())
      const result = await handle.completion.finally(() => onRegisterExtensionCancellation?.(runId, null))
      if (isLocalAnswerResult(result)) {
        onActivity?.({
          id: runId, phase: 'complete', kind: 'skill', label: callLabel, nodeId: invocationNodeId,
          answer: result.text, durationMs: Date.now() - startedAt,
        })
        return
      }
      let resultNodeId: string | undefined
      if (followUp) {
        // The revision replaces the previous agent output in one undoable step.
        const { nodeIds, replaced } = replaceAiOutput(editor, invocationNodeId, runId, result)
        if (conversation?.replacesRunId) recordReplacedOutput(conversation.replacesRunId, replaced)
        resultNodeId = nodeIds[0]
      } else {
        setAgentActivity(editor, localOutputNodeId!, null)
        ;[resultNodeId] = commitStructuredAgentResultInto(
          editor,
          invocationNodeId,
          localOutputNodeId!,
          skill.label,
          result,
        )
        localOutputNodeId = null
      }
      if (resultNodeId) await recordResultActivity(repository, runId, resultNodeId, onActivity)
      onActivity?.({
        id: runId, phase: 'complete', kind: 'skill', label: callLabel, nodeId: invocationNodeId,
        durationMs: Date.now() - startedAt, ...(followUp ? { answer: '' } : {}),
      })
    })().catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error)
      if (localOutputNodeId) {
        setAgentActivity(editor, localOutputNodeId, null)
        removeAiList(editor, localOutputNodeId)
      }
      // A failed or cancelled reply keeps no partial answer; the outline was never touched.
      const clearAnswer = followUp ? { answer: '' } : {}
      if (typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError') {
        onActivity?.({
          id: runId, phase: 'cancelled', kind: 'skill', label: callLabel, nodeId: invocationNodeId,
          durationMs: Date.now() - startedAt, ...clearAnswer,
        })
        onError(null)
        return
      }
      onActivity?.({
        id: runId,
        phase: 'error',
        kind: 'skill',
        label: callLabel,
        detail,
        nodeId: invocationNodeId,
        durationMs: Date.now() - startedAt,
        ...clearAnswer,
      })
      onError(detail)
      showSkillContextError(editor, invocationNodeId, detail)
      setContextError(detail)
    })
    clearSkillContext(editor)
    setContextError(null)
    setMenu(null)
  }

  const runSkillRef = useRef(runSkill)
  runSkillRef.current = runSkill

  // Runs requested elsewhere: the reader's Summarize and activity steering.
  useEffect(() => {
    if (!editor) return
    const onRunRequest = (event: Event) => {
      const request = (event as CustomEvent<SkillRunRequest>).detail
      if (!request) return
      const skill = useSettingsStore.getState().skills.find((candidate) => candidate.label === request.skillLabel)
      if (!skill) {
        onError(`/${request.skillLabel} no longer exists.`)
        return
      }
      runSkillRef.current(skill, request.prompt, request.invocationNodeId, request.steering, request.conversation)
    }
    window.addEventListener(OUTLINE_RUN_SKILL_EVENT, onRunRequest)
    return () => window.removeEventListener(OUTLINE_RUN_SKILL_EVENT, onRunRequest)
  }, [editor, onError])

  if (!menu || matches.length === 0) return null

  return (
    <ul className="slash-menu t-dropdown is-open" data-origin="top-left" style={{ top: menu.top, left: menu.left }}>
      {contextError && <li className="slash-context-error" role="alert">{contextError}</li>}
      {matches.map((command, index) => (
        <li
          key={`${command.outlineCommand ? 'outline' : 'skill'}:${command.id}`}
          className={index === active ? 'slash-item active' : 'slash-item'}
          onMouseDown={(event) => {
            event.preventDefault()
            complete(command)
          }}
        >
          <span className="slash-label">/{command.label}</span>
          <span className="slash-desc">
            {menu.query === command.label && menu.prompt.trim()
              ? 'Press Enter to run with this prompt'
              : [command.description, 'Enter or Tab to select'].filter(Boolean).join(' · ')}
          </span>
        </li>
      ))}
    </ul>
  )
}

/**
 * Persist a pointer to the bullets an agent wrote so the sidebar can still open them
 * after a restart, and surface it live in the current session.
 */
async function recordResultActivity(
  repository: NativeEventRepository,
  runId: string,
  resultNodeId: string,
  onActivity?: ActivityReporter,
): Promise<void> {
  const event: RuntimeActivityEvent = {
    id: `result-${runId}`,
    sequence: (await repository.agentActivityAfter(runId, 0, 200)).length + 1,
    callId: runId,
    phase: 'complete',
    kind: 'output',
    label: 'Open result',
    nodeId: resultNodeId,
    status: 'success',
  }
  await repository.appendAgentActivity(runId, event, new Date().toISOString())
  onActivity?.(fromRuntimeEvent(event, runId))
}
