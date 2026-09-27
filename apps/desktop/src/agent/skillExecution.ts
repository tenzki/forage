import type { Editor } from '@tiptap/core'
import { isExtensionSkill } from './definitions'
import { resolveAgentContext, resolveFollowUpContext } from './context'
import { commitExtensionSkillResult, commitStructuredAgentResultInto, insertAiChildUnder, removeAiList, replaceAiOutput, writeAiText } from './insertIntoEditor'
import { clearSkillContext, showExtensionSkillContext, showSkillContextError } from '../editor/contextPreview'
import { useSettingsStore } from '../store/settingsStore'
import type { ActivityReporter } from './activity'
import { fromRuntimeEvent, runActivityLabel } from './activityCalls'
import { recordReplacedOutput, type SkillRunConversation, type SkillRunSteering } from './skillRuns'
import { nativeLocalCredentialVault, resolveExtensionExecutorSecretValues, resolveExtensionSecretValues, resolveLocalCredential } from './localCredentials'
import { NativeEventRepository } from '../persistence/eventStore'
import { LocalAgentExecutor } from './localExecutor'
import { serverRunManager } from './serverRunManager'
import { serverCallErrorMessage, serverRunFailureMessage } from './serverCallErrors'
import { createPiLocalRunner } from './piLocalRunner'
import { buildOutlineSnapshot } from './outlineSnapshot'
import { BUILTIN_TOOL_OPTIONS } from './tools'
import { setAgentActivity } from '../editor/outlinerUi'
import { assertExtensionExecutionLocation, prepareExtensionSkillInvocation, retainPreparedExtensionSkillResult } from './extensionSkillInvocation'
import { createLocalExtensionSnapshotFromCatalog, isLocalAnswerResult, resolveEffectiveToolIds, selectMcpSnapshot, type ActivityEvent as RuntimeActivityEvent, type RunInput } from '@forage/agent-runtime'
import { extensionToolOptions, useExtensionStore } from '../store/extensionStore'
import { mcpToolOptions, useMcpStore } from '../store/mcpStore'
import { previewSkillContext } from './skillPreview'

export interface SkillExecutionRequest {
  editor: Editor
  skillId: string
  invocationNodeId: string
  prompt: string
  steering?: SkillRunSteering
  conversation?: SkillRunConversation
}

export interface SkillExecutionObservers {
  onError: (message: string | null) => void
  onActivity?: ActivityReporter
  onContextError?: (message: string | null) => void
  onBeforeServerRun?: () => Promise<void>
  onAfterServerRun?: () => Promise<void>
}

export interface SkillExecutionHandle {
  runId: string
  /** Resolves after execution and placement settle; failures are reported through observers. */
  completion: Promise<void>
  cancel: () => void
}

/** Desktop application boundary shared by slash commands and conversation replies.
 * Backend runs submit intent only: the backend resolves its own context and authority.
 */
function execute(request: SkillExecutionRequest, observers: SkillExecutionObservers): SkillExecutionHandle {
  const runId = crypto.randomUUID()
  const controller = new AbortController()
  let cancelExecution: (() => void) | null = null
  const registerCancellation = (cancel: (() => void) | null) => {
    cancelExecution = cancel
    if (controller.signal.aborted) cancel?.()
  }
  const completion = executeInvocation(request, observers, { runId, controller, registerCancellation })
    .catch((error: unknown) => {
      if (controller.signal.aborted) {
        observers.onError(null)
        return
      }
      const detail = error instanceof Error ? error.message : String(error)
      observers.onError(detail)
      observers.onContextError?.(detail)
      if (!request.editor.isDestroyed) showSkillContextError(request.editor, request.invocationNodeId, detail)
    }).finally(() => { cancelExecution = null })
  return {
    runId,
    completion,
    cancel: () => {
      controller.abort(new DOMException('Skill cancelled by the user.', 'AbortError'))
      cancelExecution?.()
    },
  }
}

export const skillExecution = {
  execute,
  preview: previewSkillContext,
  subscribeAvailability: (listener: () => void) => useExtensionStore.subscribe((state, previous) => {
    if (state.catalog !== previous.catalog || state.configuration !== previous.configuration) listener()
  }),
}

async function executeInvocation(
  request: SkillExecutionRequest,
  observers: SkillExecutionObservers,
  execution: { runId: string; controller: AbortController; registerCancellation: (cancel: (() => void) | null) => void },
): Promise<void> {
  const { editor, prompt, invocationNodeId, steering, conversation } = request
  const { onError, onActivity, onContextError, onBeforeServerRun, onAfterServerRun } = observers
  const { runId, controller, registerCancellation } = execution
  if (editor.isDestroyed) throw new Error('The outline is no longer open.')
  const { authMode, localCredentials, modelId, enabledToolIds, customTools, agents, skills, setOAuthCredential } = useSettingsStore.getState()
  const skill = skills.find((candidate) => candidate.id === request.skillId)
  if (!skill) throw new Error('The selected skill no longer exists.')
  const { catalog: extensionCatalog, configuration: extensionConfiguration } = useExtensionStore.getState()
  if (isExtensionSkill(skill)) {
    const callLabel = runActivityLabel(skill.label, prompt)
    onError(null)
    onActivity?.({ id: runId, phase: 'start', kind: 'skill', label: callLabel, nodeId: invocationNodeId, ...(prompt ? { detail: prompt } : {}) })
    return (async () => {
      const startedAt = Date.now()
      const repository = new NativeEventRepository()
      let prepared: Awaited<ReturnType<typeof prepareExtensionSkillInvocation>> | null = null
      try {
        assertExtensionExecutionLocation(await repository.storageMode())
        controller.signal.throwIfAborted()
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
        onContextError?.(null)
      } finally {
        await prepared?.admission.release()
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
        onContextError?.(null)
      } else {
        onError(detail)
        showSkillContextError(editor, invocationNodeId, detail)
        onContextError?.(detail)
      }
    })
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
  const startedAt = Date.now()
  const callLabel = runActivityLabel(skill.label, steering?.basePrompt ?? prompt)
  let localOutputNodeId: string | null = null
  // A reply joins its call's thread at once, before the run is admitted.
  onActivity?.({
    id: runId,
    phase: 'start',
    kind: 'skill',
    label: callLabel,
    nodeId: invocationNodeId,
    ...(prompt ? { detail: steering?.basePrompt ?? prompt } : {}),
    ...(steering ? { note: steering.note } : {}),
    ...(followUp && conversation ? { thread: { callId: conversation.callId, turn: conversation.turn } } : {}),
  })
  let serverRun = false
  const completion = (async () => {
    const followUpContext = followUp ? resolveFollowUpContext(editor.state.doc, invocationNodeId) : null
    const context = followUpContext?.context ?? contextSnapshot!
    const mode = await repository.storageMode()
    controller.signal.throwIfAborted()
    if (mode === 'server') {
      serverRun = true
      await onBeforeServerRun?.()
      const connection = await repository.serverConnection()
      if (!connection) throw new Error('Server mode is not configured.')
      const sync = await repository.syncState(connection.outlineId)
      // A reply resumes the server call; the server resolves its context. A call
      // whose first turn never completed has nothing to resume and starts over.
      controller.signal.throwIfAborted()
      const handle = await serverRunManager.invoke({
        version: 2, invocationId: runId, sourceNodeId: invocationNodeId,
        skillId: skill.id, prompt: prompt || skill.label,
        acknowledgedOutlineRevision: sync.lastPulledRevision,
        ...(followUp && conversation ? { conversation: { callId: conversation.callId, turn: conversation.turn } } : {}),
      }, onActivity, { label: callLabel, ...(steering ? { note: steering.note } : {}) })
      registerCancellation(() => void handle.cancel())
      const completed = await handle.completion.finally(() => registerCancellation(null))
      if (completed.status === 'failed') throw new Error(serverRunFailureMessage(completed))
      if (completed.status === 'cancelled' || completed.status === 'interrupted') {
        throw new DOMException('The server run was cancelled.', 'AbortError')
      }
      if (completed.status === 'completed_unplaced') {
        onActivity?.({
          id: `placement-${runId}`, callId: runId, phase: 'error', kind: 'output',
          label: 'Result needs a destination',
          detail: 'The bullet this run wrote to was removed. The output is kept on the server.',
          nodeId: invocationNodeId,
        })
      } else if (!completed.answer) {
        // The server committed the result, or the revision replacing the previous
        // version, as one outline event; pull it now.
        await onAfterServerRun?.()
      }
      onActivity?.({
        id: runId, phase: 'complete', kind: 'skill', label: callLabel, nodeId: invocationNodeId,
        durationMs: Date.now() - startedAt, ...(completed.answer ? { answer: completed.answer } : {}),
      })
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
    if (!useMcpStore.getState().loaded) await useMcpStore.getState().load()
    const mcpConnections = useMcpStore.getState().connections
    const effectiveToolIds = resolveEffectiveToolIds({
      agentToolIds: agent.toolIds, requiredToolIds: skill.requiredToolIds,
      globallyEnabledToolIds: enabledToolIds, policyAllowedToolIds: agent.toolIds,
      executorSupportedToolIds: [
        ...BUILTIN_TOOL_OPTIONS.map((tool) => tool.id),
        ...customTools.map((tool) => tool.id),
        ...supportedExtensionToolIds,
        ...mcpToolOptions(mcpConnections).filter((tool) => tool.available).map((tool) => tool.id),
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
      mcpSnapshot: selectMcpSnapshot(mcpConnections, effectiveToolIds),
      thread,
      ...(followUpContext ? { invocationOutline: followUpContext.invocationOutline } : {}),
    }
    onActivity?.({ id: runId, phase: 'start', kind: 'skill', label: callLabel, nodeId: invocationNodeId, thread })
    const runner = createPiLocalRunner({
      resolveMcpConnections: (snapshot) => useMcpStore.getState().resolve(snapshot),
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
    controller.signal.throwIfAborted()
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
    registerCancellation(() => void handle.cancel())
    const result = await handle.completion.finally(() => registerCancellation(null))
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
    const detail = serverRun ? serverCallErrorMessage(error, followUp) : error instanceof Error ? error.message : String(error)
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
    onContextError?.(detail)
  })
  clearSkillContext(editor)
  onContextError?.(null)
  return completion
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
