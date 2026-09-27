import type { Api, Model } from '@earendil-works/pi-ai'
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type ModelRuntime,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import {
  AgentRuntimeError,
  isAbortError,
  runInputSchema,
  type ActivityEvent,
  type RunInput,
  type RunThread,
  type RuntimeTool,
  type UntrustedSourceMaterial,
} from '@forage/agent-runtime'
import { ActivityMapper } from './activity'
import { CONVERSATION_UNAVAILABLE, type ConversationStore, type ConversationTurn } from './conversation-store'
import { createEmitOutlineTool, EMIT_OUTLINE_TOOL, isEmittedOutline, type EmittedOutline, type ImageReferences } from './emit-outline'
import { FinalResponseTracker } from './final-response'
import { installTurnGuards, toolRoundLimit } from './limits'
import { composeSystemPrompt, composeTaskMessage } from './prompt'
import { adaptRuntimeTool } from './runtime-tools'
import { VerifiedSources } from './sources'
import { selectEffectiveTools } from './tool-policy'

/** One turn of a call, normalized from either environment's run input. */
export interface PiTurnRequest {
  runId: string
  executionMode: 'local' | 'server'
  /** Agent instructions, then skill instructions. */
  instructions: string[]
  prompt: string
  context: string[]
  invocationOutline?: string[]
  thread?: RunThread
  effectiveToolIds: string[]
  requiredToolIds: string[]
  /** Captured material an automation run starts from. */
  sources?: UntrustedSourceMaterial[]
}

export function turnRequestFromRunInput(rawInput: RunInput, sources: UntrustedSourceMaterial[] = []): PiTurnRequest {
  const input = runInputSchema.parse(rawInput)
  return {
    runId: input.runId,
    executionMode: input.executionMode,
    instructions: [input.agent.systemPrompt, input.skill.systemPrompt],
    prompt: input.prompt,
    context: input.context,
    ...(input.invocationOutline ? { invocationOutline: input.invocationOutline } : {}),
    ...(input.thread ? { thread: input.thread } : {}),
    effectiveToolIds: input.effectiveToolIds,
    requiredToolIds: input.skill.requiredToolIds,
    ...(sources.length ? { sources } : {}),
  }
}

/** What an environment-specific Pi tool may use during the turn. */
export interface TurnToolContext {
  /** Register URLs a source-reading tool returned, so the result may cite them. */
  sources: VerifiedSources
}

export interface PiTurnAdapters {
  modelRuntime: ModelRuntime
  model: Model<Api>
  /** Environment tools in the shared runtime shape, adapted to Pi with bounds and source capture. */
  runtimeTools?: readonly RuntimeTool[]
  /** Environment tools already defined for Pi, such as the sidecar's local tools. */
  piTools?: (context: TurnToolContext) => readonly ToolDefinition[]
  /** Resolves image IDs that `emit_outline` nodes reference. */
  images: ImageReferences
  /** Required for resumed turns; without it a first turn keeps its transcript in memory only. */
  conversation?: ConversationStore
  onActivity?: (event: ActivityEvent) => void
  onDelta?: (text: string) => void
  /** Every Pi session event, for callers that forward the raw stream. */
  onSessionEvent?: (event: AgentSessionEvent) => void
}

export interface PiTurnOptions {
  signal?: AbortSignal
  /** Tool rounds before the turn fails; 8 by default and never more than 20. */
  maxToolRounds?: number
  cwd?: string
  agentDir?: string
}

export type PiTurnOutcome =
  | { type: 'outline'; outline: EmittedOutline }
  | { type: 'answer'; text: string }

/**
 * Run one turn of a call on Pi with the prompt rules, tool policy, limits and
 * outcome handling both environments share. A first turn must end with an outline in
 * server mode; locally its text becomes a fallback answer. A resumed turn may answer
 * inline. A failed or cancelled turn rolls its transcript back before rethrowing.
 */
export async function runPiTurn(
  request: PiTurnRequest,
  adapters: PiTurnAdapters,
  options: PiTurnOptions = {},
): Promise<PiTurnOutcome> {
  const signal = options.signal
  if (signal?.aborted) throw abortError()
  const followUp = (request.thread?.turn ?? 1) > 1
  const maxToolRounds = toolRoundLimit(options.maxToolRounds)
  const cwd = options.cwd ?? process.cwd()
  const sources = new VerifiedSources()
  const tools = selectEffectiveTools({
    tools: [
      ...(adapters.piTools?.({ sources }) ?? []),
      ...(adapters.runtimeTools ?? []).map((tool) => adaptRuntimeTool(tool, sources)),
    ],
    authorizedToolIds: new Set(request.effectiveToolIds),
    requiredToolIds: request.requiredToolIds,
    outputTool: createEmitOutlineTool(adapters.images, sources),
  })
  if (followUp && !adapters.conversation) throw new AgentRuntimeError('conversation_unavailable', CONVERSATION_UNAVAILABLE)

  const activity = new ActivityMapper(request.runId, adapters.onActivity)
  const promptInput = { ...request, followUp }
  let conversation: ConversationTurn | undefined
  let session: AgentSession | undefined
  try {
    conversation = request.thread && adapters.conversation
      ? await adapters.conversation.openTurn(request.thread)
      : undefined
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: options.agentDir ?? '',
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPromptOverride: () => composeSystemPrompt(promptInput),
      agentsFilesOverride: () => ({ agentsFiles: [] }),
    })
    await loader.reload()
    ;({ session } = await createAgentSession({
      cwd,
      model: adapters.model,
      modelRuntime: adapters.modelRuntime,
      sessionManager: conversation?.sessionManager ?? SessionManager.inMemory(cwd),
      settingsManager: SettingsManager.inMemory(),
      resourceLoader: loader,
      noTools: 'all',
      tools: tools.map((tool) => tool.name),
      customTools: tools,
      thinkingLevel: 'low',
    }))
    const activeSession = session

    const guards = installTurnGuards(activeSession, {
      authorizedToolNames: new Set(tools.map((tool) => tool.name)),
      maxToolRounds,
    })
    const finalResponse = new FinalResponseTracker()
    let emitted: EmittedOutline | undefined
    const unsubscribe = activeSession.subscribe((event) => {
      adapters.onSessionEvent?.(event)
      activity.handle(event)
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
        adapters.onDelta?.(event.assistantMessageEvent.delta)
      } else if (event.type === 'tool_execution_end') {
        finalResponse.recordToolEnd(event.toolName, event.isError)
        const details = (event.result as { details?: unknown } | undefined)?.details
        if (event.toolName === EMIT_OUTLINE_TOOL && !event.isError && isEmittedOutline(details)) emitted = details
      } else if (event.type === 'agent_end') {
        finalResponse.recordAgentEnd(event.messages, event.willRetry)
      }
    })
    const onAbort = () => { void activeSession.abort().catch(() => undefined) }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      if (signal?.aborted) throw abortError()
      await activeSession.prompt(composeTaskMessage(promptInput), { expandPromptTemplates: false })
    } finally {
      signal?.removeEventListener('abort', onAbort)
      unsubscribe()
      guards.dispose()
    }

    if (signal?.aborted) throw abortError()
    if (guards.roundLimitReached()) {
      throw new AgentRuntimeError('tool_round_limit', `Model exceeded the ${maxToolRounds}-round tool limit`)
    }
    const settled = finalResponse.settledEvent()
    if (settled.type === 'process_error') throw new ModelProviderError(settled.error)
    if (emitted) return { type: 'outline', outline: emitted }
    if (!followUp && request.executionMode === 'server') {
      throw new AgentRuntimeError('structured_result_required', 'Model did not return a structured result')
    }
    if (!settled.text) throw new AgentRuntimeError('empty_response', 'The agent finished without a response.')
    activity.answered()
    return { type: 'answer', text: settled.text }
  } catch (error) {
    await conversation?.rollback()
    if (signal?.aborted || isAbortError(error)) {
      activity.cancelled()
      throw abortError()
    }
    activity.failed()
    throw error
  } finally {
    session?.dispose()
  }
}

/** The model provider failed the turn, for example rejecting the credential or rate limiting it. */
export class ModelProviderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ModelProviderError'
  }
}

function abortError(): DOMException {
  return new DOMException('Agent run cancelled.', 'AbortError')
}
