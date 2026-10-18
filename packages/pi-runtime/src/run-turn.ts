import { createHash } from 'node:crypto'
import type { Api, AssistantMessage, Message, Model } from '@earendil-works/pi-ai'
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context'
import {
  AssistantEntry, GenerationTask, Harness, MemoryStorage, ToolTask,
  createRegistry, defineDoc, defineExtension, defineTool as durableTool, hook, section, watchEvents,
  type Conversation, type ConversationId, type EntryId, type EntryRecord, type EntryDraft, type JsonObject,
  type Storage, type ToolRegistration,
} from '@earendil-works/pi-durable'
import {
  AgentRuntimeError, isAbortError, runInputSchema,
  type ActivityEvent, type RunInput, type RunThread, type RuntimeTool, type UntrustedSourceMaterial,
} from '@forage/agent-runtime'
import { ActivityMapper } from './activity'
import { CONVERSATION_UNAVAILABLE, type ConversationStore, type ConversationTurn } from './conversation-store'
import { createEmitOutlineTool, EMIT_OUTLINE_TOOL, isEmittedOutline, type EmittedOutline, type ImageReferences, type OutlineImage } from './emit-outline'
import { CALL_LIMIT_MESSAGE, MAX_CALLS_PER_RESPONSE, toolRoundLimit } from './limits'
import { composeSystemPrompt, composeTaskMessage } from './prompt'
import { adaptRuntimeTool } from './runtime-tools'
import type { ModelRuntime } from './runtime-auth'
import { VerifiedSources } from './sources'
import { selectEffectiveTools, UNAUTHORIZED_TOOL_MESSAGE } from './tool-policy'
import { redactValue, redactedModels } from './redaction'
import type { PiSessionEvent, ToolDefinition } from './tools'

export interface PiTurnRequest {
  runId: string
  /** Digest of non-secret environment-specific admission, including tool/configuration snapshots. */
  admissionFingerprint?: string
  executionMode: 'local' | 'server'
  instructions: string[]
  prompt: string
  context: string[]
  invocationOutline?: string[]
  thread?: RunThread
  effectiveToolIds: string[]
  requiredToolIds: string[]
  sources?: UntrustedSourceMaterial[]
}

export function turnRequestFromRunInput(rawInput: RunInput, sources: UntrustedSourceMaterial[] = []): PiTurnRequest {
  const input = runInputSchema.parse(rawInput)
  return {
    runId: input.runId, admissionFingerprint: fingerprintAdmission(input), executionMode: input.executionMode,
    instructions: [input.agent.systemPrompt, input.skill.systemPrompt], prompt: input.prompt, context: input.context,
    ...(input.invocationOutline ? { invocationOutline: input.invocationOutline } : {}),
    ...(input.thread ? { thread: input.thread } : {}),
    effectiveToolIds: input.effectiveToolIds, requiredToolIds: input.skill.requiredToolIds,
    ...(sources.length ? { sources } : {}),
  }
}

export interface TurnToolContext { sources: VerifiedSources }
export interface PiTurnAdapters {
  modelRuntime: ModelRuntime
  model: Model<Api>
  runtimeTools?: readonly RuntimeTool[]
  piTools?: (context: TurnToolContext) => readonly ToolDefinition[]
  images: ImageReferences
  conversation?: ConversationStore
  onActivity?: (event: ActivityEvent) => void
  onDelta?: (text: string) => void
  onSessionEvent?: (event: PiSessionEvent) => void
  /** Resolved at every use, including newly obtained MCP access tokens. */
  secrets?: () => readonly string[]
  /** Fenced server lease check before model requests and external tool effects. */
  assertOwnership?: () => Promise<void>
  beforeRun?: () => Promise<void>
  afterRun?: (outcome: 'completed' | 'failed' | 'cancelled') => Promise<void>
}
export interface PiTurnOptions {
  signal?: AbortSignal
  /** Process shutdown closes the Harness without aborting durable tasks. */
  suspendSignal?: AbortSignal
  maxToolRounds?: number
}
export type PiTurnOutcome = { type: 'outline'; outline: EmittedOutline } | { type: 'answer'; text: string }

type CallState = { completedTurn: number; head: number; runs: Record<string, number> }
const CallDoc = defineDoc<CallState>({
  kind: 'forage.call', version: 1, scope: 'session', initial: () => ({ completedTurn: 0, head: 0, runs: {} }),
})
type RunState = {
  fingerprint: string
  submissionKey?: string
  completed: boolean
  startHook?: 'intent' | 'done'
  endHook?: 'intent' | 'done'
  rounds: number
  counted: Record<string, boolean>
  limitReached: boolean
  sources: string[]
  images: Record<string, { src: string; prompt: string }>
  outcome?: JsonObject
}
const RunDoc = defineDoc<RunState>({
  kind: 'forage.run', version: 1, scope: 'conversation', history: 'latest', fork: 'initial',
  initial: () => ({ fingerprint: '', completed: false, rounds: 0, counted: {}, limitReached: false, sources: [], images: {} }),
})
const context = BACKGROUND_CONTEXT

/** Execute or recover an admitted run. Durable owns execution; Forage owns result placement. */
export async function runPiTurn(request: PiTurnRequest, adapters: PiTurnAdapters, options: PiTurnOptions = {}): Promise<PiTurnOutcome> {
  const signal = options.signal
  const suspendSignal = options.suspendSignal
  if (suspendSignal?.aborted) throw new RunSuspended()
  if (signal?.aborted) throw abortError()
  const followUp = (request.thread?.turn ?? 1) > 1
  if (followUp && !adapters.conversation) throw new AgentRuntimeError('conversation_unavailable', CONVERSATION_UNAVAILABLE)
  const maxRounds = toolRoundLimit(options.maxToolRounds)
  const secrets = adapters.secrets ?? (() => [])
  const clean = <T>(value: T) => redactValue(value, secrets())
  const sources = new VerifiedSources()
  const tools = selectEffectiveTools({
    tools: [...(adapters.piTools?.({ sources }) ?? []), ...(adapters.runtimeTools ?? []).map((tool) => adaptRuntimeTool(tool, sources))],
    authorizedToolIds: new Set(request.effectiveToolIds), requiredToolIds: request.requiredToolIds,
    outputTool: createEmitOutlineTool(adapters.images, sources),
  })
  const authorized = new Set(tools.map((tool) => tool.name))
  const activity = new ActivityMapper(request.runId, adapters.onActivity,
    new Map(tools.filter((tool) => tool.name.startsWith('mcp_')).map((tool) => [tool.name, tool.label])))
  let opened: ConversationTurn | undefined
  let harness: Harness | undefined
  let root: Conversation | undefined
  let stopEvents: (() => Promise<void>) | undefined
  let aborting: Promise<void> | undefined
  let suspending: Promise<void> | undefined
  let streamedAnswer = ''
  let emittedEvent = false
  let lifecycleStarted = false
  const emit = (event: PiSessionEvent) => { if (signal?.aborted) return; activity.handle(event); adapters.onSessionEvent?.(event) }
  const abort = () => {
    if (root && !aborting) aborting = root.abort(context, { background: true }).then(() => undefined)
    void aborting?.catch(() => undefined)
  }
  const suspend = () => {
    if (harness && !suspending) suspending = harness.close(context)
    void suspending?.catch(() => undefined)
  }
  try {
    const thread = request.thread ?? { callId: request.runId, turn: 1 }
    opened = adapters.conversation ? await adapters.conversation.openTurn(thread)
      : { storage: new MemoryStorage(), close: async () => undefined }
    const storage: Storage = opened.storage
    const registry = createRegistry()
    const promptInput = { ...request, followUp }
    const durableTools: ToolRegistration[] = tools.map((tool) => durableTool({
      name: tool.name, description: tool.description, parameters: tool.parameters,
      // Unknown extensions, custom HTTP and MCP tools remain unsafe unless explicitly declared.
      replay: tool.replay ?? 'unsafe', callers: ['model'],
      execute: async (args, api, callContext) => {
        await adapters.assertOwnership?.()
        const result = clean(await tool.execute(api.callId, args, callContext.abortSignal))
        await api.commit(async (tx) => {
          const state = await tx.doc(RunDoc, api.conversationId)
          state.sources = clean(sources.values())
          state.images = clean(imageSnapshot(adapters.images))
          if (tool.name === EMIT_OUTLINE_TOOL && isEmittedOutline(result.details)) {
            state.outcome = { type: 'outline', outline: result.details } as unknown as JsonObject
          }
        }, callContext)
        return {
          output: result.content, ...(result.details === undefined ? {} : { details: result.details as JsonObject }),
          ...(result.terminate ? { control: { terminate: true as const } } : {}),
        }
      },
    }))
    registry.install(defineExtension({
      name: 'forage', tools: durableTools,
      sections: [section('forage', () => clean(composeSystemPrompt(promptInput)), { tag: false })],
      hooks: [
        hook(GenerationTask, {
          beforeRequest: async (input, api, callContext) => {
            await adapters.assertOwnership?.()
            const state = await api.snapshot(RunDoc, api.conversationId, callContext)
            if ((state?.rounds ?? 0) >= maxRounds) {
              await harness!.commit(async (tx) => { (await tx.doc(RunDoc, api.conversationId)).limitReached = true }, callContext)
              abort()
              // Abort is asynchronous and joins this invocation. Wait only for its signal, never for the join.
              await new Promise<never>((_, reject) => {
                if (callContext.abortSignal?.aborted) reject(abortError())
                else callContext.abortSignal?.addEventListener('abort', () => reject(abortError()), { once: true })
              })
            }
            return { messages: input.messages.map((message) => message.role === 'toolResult' && !authorized.has(message.toolName)
              ? { ...message, content: [{ type: 'text' as const, text: UNAUTHORIZED_TOOL_MESSAGE }], isError: true } : message) }
          },
          afterResponse: async (message, api, callContext) => {
            if (!message.content.some((part) => part.type === 'toolCall')) return
            await harness!.commit(async (tx) => {
              const state = await tx.doc(RunDoc, api.conversationId)
              if (!state.counted[String(api.taskId)]) {
                state.counted[String(api.taskId)] = true
                state.rounds += 1
              }
            }, callContext)
          },
        }),
        hook(ToolTask, {
          beforeTool: async (call, api, callContext) => {
            if (!authorized.has(call.name)) return { block: UNAUTHORIZED_TOOL_MESSAGE }
            const task = await harness!.getTask(api.taskId, callContext)
            const input = task?.input as { assistant?: number } | undefined
            const assistant = input?.assistant
              ? await harness!.commit((tx) => tx.entry(input.assistant as EntryId), callContext) : undefined
            const message = assistant?.model?.find((message) => message.role === 'assistant')
            const calls = message?.role === 'assistant' ? message.content.filter((part) => part.type === 'toolCall') : []
            if (calls.findIndex((candidate) => candidate.id === call.id) >= MAX_CALLS_PER_RESPONSE) return { block: CALL_LIMIT_MESSAGE }
            return { arguments: clean(call.arguments) as JsonObject }
          },
        }),
      ],
    }))
    harness = await Harness.open(storage, {
      models: redactedModels(adapters.modelRuntime, secrets, adapters.assertOwnership), registry,
      settings: {
        extensions: [], toolExecution: 'sequential', retry: { enabled: false },
        stream: { timeoutMs: 120_000, maxRetries: 0 },
        progress: { partialIntervalMs: 100, outputIntervalMs: 100 },
      },
    }, context)
    suspendSignal?.addEventListener('abort', suspend, { once: true })
    if (suspendSignal?.aborted) suspend()
    const base = await harness.root(context)
    let call = await harness.snapshot(CallDoc, context)
    if (!call) {
      const imported = await importTranscript(base, opened.legacyEntries ?? [], clean, thread.turn)
      if (followUp && !imported) throw new AgentRuntimeError('conversation_unavailable', CONVERSATION_UNAVAILABLE)
      call = (await harness.snapshot(CallDoc, context))!
    }
    const key = `${request.runId}:${thread.turn}`
    const fingerprint = fingerprintAdmission(clean({ request, model: { provider: adapters.model.provider, id: adapters.model.id }, maxRounds }))
    const existing = call.runs[key]
    root = existing ? await harness.conversation(existing as ConversationId, context) : undefined
    let run = root ? await harness.snapshot(RunDoc, root.id, context) : undefined
    if (run && run.fingerprint !== fingerprint) throw new Error('An admitted run cannot change during recovery.')
    if (run?.completed && run.outcome) {
      const outcome = run.outcome as unknown as PiTurnOutcome
      await captureEntries(root!, opened)
      replayOutcome(outcome)
      return outcome
    }
    let submissionKey = run?.submissionKey ?? key
    if (root) {
      const previous = await storage.submissionByRequest(root.id, submissionKey, context)
      if (previous && (previous.status === 'unanswered' || (previous.status === 'done' && !run?.outcome))) {
        // Retry the failed generation on the same admitted run. Its completed tool
        // receipts must stay in context; starting the whole turn over could repeat
        // an external write. A different user run still forks the successful head.
        submissionKey = `${key}:retry:${previous.id}`
        await harness.commit(async (tx) => { (await tx.doc(RunDoc, root!.id)).submissionKey = submissionKey }, context)
      }
    }
    if (!root) {
      if (thread.turn > call.completedTurn + 1 || thread.turn <= call.completedTurn) throw new AgentRuntimeError('conversation_unavailable', CONVERSATION_UNAVAILABLE)
      const parent = call.head ? await harness.conversation(call.head as ConversationId, context) : undefined
      const tail = parent ? (await parent.entries({}, 1, undefined, context)).items[0] : undefined
      const agent = { model: { provider: adapters.model.provider, modelId: adapters.model.id }, thinkingLevel: 'low' as const,
        extensions: [registry.snapshot().extension('forage')!], tools: durableTools }
      root = parent && tail
        ? await parent.fork(tail.id, { ownership: { kind: 'ownerless' }, agent }, context)
        : await harness.createConversation({ ownership: { kind: 'ownerless' }, agent }, context)
      await harness.commit(async (tx) => {
        ;(await tx.doc(CallDoc)).runs[key] = root!.id
        ;(await tx.doc(RunDoc, root!.id)).fingerprint = fingerprint
      }, context)
      run = await harness.snapshot(RunDoc, root.id, context)
    }
    for (const url of run?.sources ?? []) sources.register(url)
    restoreImages(adapters.images, run?.images ?? {})
    lifecycleStarted = true
    await lifecycle('startHook', adapters.beforeRun)
    const stream = await watchEvents(harness, root.id, context)
    stream.start(async (events) => {
      for (const event of events) {
        if (event.type === 'message_start' && event.message.role === 'assistant') {
          streamedAnswer = ''
        } else if (event.type === 'message_update') {
          for (const change of event.changes) if (change.type === 'text_delta') {
            streamedAnswer += change.delta
            emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: change.delta } })
            adapters.onDelta?.(change.delta)
          }
        } else if (event.type === 'message_end') {
          for (const message of event.entry.model ?? []) emit({ type: 'message_end', message })
        } else if (event.type === 'tool_execution_start') {
          emit({ type: 'tool_execution_start', toolCallId: event.toolCallId, toolName: event.toolName, args: event.args })
        } else if (event.type === 'tool_execution_end' && event.entry) {
          const result = event.entry.model?.find((message) => message.role === 'toolResult')
          if (result?.role === 'toolResult') {
            const details = result.details
            if (event.toolName === EMIT_OUTLINE_TOOL && isEmittedOutline(details)) emittedEvent = true
            emit({ type: 'tool_execution_end', toolCallId: event.toolCallId, toolName: event.toolName,
              result: { content: result.content, details }, isError: result.isError })
          }
        }
      }
    })
    stopEvents = async () => { await stream.stop() }
    emit({ type: 'agent_start' })
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const content = submissionKey === key ? clean(composeTaskMessage(promptInput))
      : 'Continue the admitted task using the completed tool results above. Do not repeat a completed or interrupted external operation.'
    const submission = await root.submit({ type: 'input', content, requestId: submissionKey }, context)
    const waitSignal = signal && suspendSignal ? AbortSignal.any([signal, suspendSignal]) : signal ?? suspendSignal
    const settled = await submission.wait(waitSignal ? withAbortSignal(waitSignal, context) : context)
    await root.waitForIdle(context)
    await stopEvents?.()
    stopEvents = undefined
    run = await harness.snapshot(RunDoc, root.id, context)
    if (signal?.aborted) throw abortError()
    if (run?.limitReached) throw new AgentRuntimeError('tool_round_limit', `Model exceeded the ${maxRounds}-round tool limit`)
    if (settled.status !== 'done' || settled.type !== 'input') {
      const entries = await allEntries(root)
      const error = [...entries].reverse().flatMap((entry) => entry.model ?? []).find((message) => message.role === 'assistant' && message.errorMessage)
      throw new ModelProviderError(error?.role === 'assistant' ? error.errorMessage || 'Model request failed.' : 'Model request failed.')
    }
    let outcome = run?.outcome as unknown as PiTurnOutcome | undefined
    if (!outcome) {
      const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context)
      const message = entry?.model?.find((message) => message.role === 'assistant')
      const text = message?.role === 'assistant' ? assistantText(message) : ''
      if (!followUp && request.executionMode === 'server') throw new AgentRuntimeError('structured_result_required', 'Model did not return a structured result')
      if (!text) throw new AgentRuntimeError('empty_response', 'The agent finished without a response.')
      outcome = { type: 'answer', text }
    }
    await lifecycle('endHook', adapters.afterRun ? () => adapters.afterRun!('completed') : undefined)
    const completed = outcome
    await harness.commit(async (tx) => {
      const runState = await tx.doc(RunDoc, root!.id)
      runState.outcome = completed as unknown as JsonObject
      runState.completed = true
      const state = await tx.doc(CallDoc)
      state.head = root!.id
      state.completedTurn = thread.turn
    }, context)
    await captureEntries(root, opened)
    replayOutcome(outcome)
    return outcome
  } catch (error) {
    if (suspendSignal?.aborted && !signal?.aborted) throw new RunSuspended()
    if (lifecycleStarted && root && harness) {
      await lifecycle('endHook', adapters.afterRun ? () => adapters.afterRun!(signal?.aborted || isAbortError(error) ? 'cancelled' : 'failed') : undefined).catch(() => undefined)
    }
    if (signal?.aborted || isAbortError(error)) {
      activity.cancelled()
      throw abortError()
    }
    activity.failed()
    throw error
  } finally {
    signal?.removeEventListener('abort', abort)
    suspendSignal?.removeEventListener('abort', suspend)
    if (aborting) await aborting.catch(() => undefined)
    await stopEvents?.().catch(() => undefined)
    if (suspending) await suspending
    else if (harness) await harness.close(context)
    else await opened?.close()
  }

  async function lifecycle(key: 'startHook' | 'endHook', callback?: () => Promise<void>) {
    if (!callback) return
    const state = await harness!.snapshot(RunDoc, root!.id, context)
    if (state?.[key] === 'done') return
    if (state?.[key] === 'intent') {
      if (key === 'startHook') throw new AgentRuntimeError('extension_hook_interrupted', 'Extension start hooks were interrupted. Retry explicitly to start a new run.')
      // A possibly completed end hook must never be repeated during result recovery.
      return
    }
    await harness!.commit(async (tx) => { (await tx.doc(RunDoc, root!.id))[key] = 'intent' }, context)
    try { await callback() }
    finally { await harness!.commit(async (tx) => { (await tx.doc(RunDoc, root!.id))[key] = 'done' }, context) }
  }

  function replayOutcome(outcome: PiTurnOutcome) {
    if (outcome.type === 'answer') {
      const delta = outcome.text.startsWith(streamedAnswer) ? outcome.text.slice(streamedAnswer.length) : ''
      if (delta) {
        emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } })
        adapters.onDelta?.(delta)
      }
      activity.answered()
    }
    else if (!emittedEvent) emit({ type: 'tool_execution_end', toolCallId: `result-${request.runId}`, toolName: EMIT_OUTLINE_TOOL,
      result: { content: [{ type: 'text', text: 'Response ready.' }], details: outcome.outline }, isError: false })
  }
}

async function allEntries(root: Conversation): Promise<EntryRecord[]> {
  const result: EntryRecord[] = []
  let cursor
  do {
    const page = await root.entries({ order: 'ascending' }, 100, cursor, context)
    result.push(...page.items)
    cursor = page.next
  } while (cursor)
  return result
}

async function captureEntries(root: Conversation, opened: ConversationTurn) {
  const entries = (await allEntries(root)).filter((entry) => entry.conversationId === root.id)
  opened.complete?.(entries)
}

/** SDK entries and durable entries can both seed a new backend during an upgrade. */
async function importTranscript(root: Conversation, entries: readonly unknown[], clean: <T>(value: T) => T, turn: number): Promise<boolean> {
  const drafts: EntryDraft[] = []
  const records = entries.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
  // SDK sessions may contain abandoned branches. Follow parent IDs from the latest leaf.
  const legacy = records.filter((entry) => typeof entry.id === 'string' && entry.type !== 'session')
  let selected = records
  if (legacy.length) {
    const byId = new Map(legacy.map((entry) => [entry.id, entry]))
    selected = []
    let current: Record<string, unknown> | undefined = legacy[legacy.length - 1]
    const seen = new Set<unknown>()
    while (current && !seen.has(current.id)) {
      seen.add(current.id); selected.unshift(current); current = byId.get(current.parentId)
    }
  }
  const appendMessages = (entry: Record<string, unknown>) => {
    const messages = Array.isArray(entry.model) ? entry.model : entry.type === 'message' ? [entry.message] : []
    for (const raw of messages) {
      if (!raw || typeof raw !== 'object' || !['user', 'assistant', 'toolResult'].includes((raw as { role: string }).role)) continue
      drafts.push({ kind: 'forage.imported', model: [clean(raw as Message)] })
    }
  }
  selected.forEach((entry, index) => {
    appendMessages(entry)
    if (entry.type === 'compaction' && typeof entry.summary === 'string') {
      drafts.push({ kind: 'forage.imported-summary', head: 'self',
        model: [{ role: 'user', content: clean(entry.summary), timestamp: Date.now() }] })
      const firstKept = selected.findIndex((candidate) => candidate.id === entry.firstKeptEntryId)
      if (firstKept >= 0) for (const kept of selected.slice(firstKept, index)) appendMessages(kept)
    }
  })
  if (!drafts.length && turn > 1) return false
  // Import and its readiness marker commit together. A crash cannot leave half an imported transcript.
  await root.commit(async (tx) => {
    for (const draft of drafts) await tx.appendEntry(root.id, draft)
    const state = await tx.doc(CallDoc)
    state.head = drafts.length ? root.id : 0
    state.completedTurn = drafts.length ? turn - 1 : 0
  }, context)
  return drafts.length > 0
}

function imageSnapshot(images: ImageReferences): Record<string, OutlineImage> {
  return images instanceof Map ? Object.fromEntries(images) : images.snapshot?.() ?? {}
}
function restoreImages(images: ImageReferences, saved: Record<string, OutlineImage>) {
  if (images instanceof Map) for (const [id, image] of Object.entries(saved)) images.set(id, image)
  else images.restore?.(saved)
}
function assistantText(message: AssistantMessage): string {
  return message.content.flatMap((part) => part.type === 'text' ? [part.text] : []).join('').trim()
}
export class ModelProviderError extends Error {
  constructor(message: string) { super(message); this.name = 'ModelProviderError' }
}
function abortError(): DOMException { return new DOMException('Agent run cancelled.', 'AbortError') }

/** Canonical hashing keeps recovery independent of JSON key order and never stores admission secrets. */
export function fingerprintAdmission(value: unknown): string {
  const sorted = (input: unknown): unknown => Array.isArray(input) ? input.map(sorted)
    : input && typeof input === 'object' ? Object.fromEntries(Object.entries(input).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, item]) => [key, sorted(item)])) : input
  return createHash('sha256').update(JSON.stringify(sorted(value)) ?? 'null').digest('hex')
}

/** Suspension is not a terminal run outcome; the same submission resumes on reopen. */
export class RunSuspended extends Error {
  constructor() { super('Agent execution was suspended for process shutdown.'); this.name = 'RunSuspended' }
}
