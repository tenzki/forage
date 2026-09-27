import {
  AgentRuntimeError,
  runAgent,
  type ActivityEvent,
  type LocalRunResult,
  type ModelAdapter,
  type RuntimeTool,
} from '@forage/agent-runtime'
import { CONVERSATION_UNAVAILABLE } from '@forage/pi-runtime'
import type { AgentRunRecord, CallTurnEntries } from './agentStore.js'
import { AgentStoreError } from './agentStore.js'
import type { ServerCredentialService, ResolvedModelCredential } from './credentialService.js'
import { CredentialServiceError } from './credentialService.js'
import { ProviderError } from './transcript.js'
import type { ServerRepository } from './repository.js'
import type { AgentEngine } from './config.js'
import { createServerPiModel, runServerPiTurn, type ServerPiModel } from './piExecutor.js'
import { openCallConversation, settledTurnEntries } from './callConversations.js'

export interface ServerAgentRunnerOptions {
  repository: ServerRepository
  credentials: ServerCredentialService
  tools: RuntimeTool[] | ((run: AgentRunRecord, credential: ResolvedModelCredential) => RuntimeTool[])
  workerId: string
  leaseMs: number
  maxBackoffMs?: number
  /** The agent loop that executes runs: the shared Pi turn, or `legacy` as the rollback path. Defaults to `pi`. */
  engine?: AgentEngine
  /** The Pi engine's model; defaults to the credential's provider and the run's model. */
  piModelFactory?: (credential: ResolvedModelCredential, run: AgentRunRecord) => Promise<ServerPiModel>
  /** The legacy engine's model adapter. */
  modelFactory?: (credential: ResolvedModelCredential, run: AgentRunRecord) => ModelAdapter
  /** Where a reply's temporary session file is written; the OS temp directory by default. */
  conversationTempRoot?: string
}

export class ServerAgentRunner {
  constructor(private readonly options: ServerAgentRunnerOptions) {}

  async execute(run: AgentRunRecord): Promise<void> {
    const controller = new AbortController()
    let leaseLost = false
    const renew = async (): Promise<void> => {
      try {
        const state = await this.options.repository.agentStore.renewLease(
          run.id, this.options.workerId, new Date(), this.options.leaseMs,
        )
        if (!state.owned) { leaseLost = true; controller.abort(new Error('lease_lost')) }
        else if (state.cancelRequested) controller.abort(new DOMException('Cancelled', 'AbortError'))
      } catch { leaseLost = true; controller.abort(new Error('lease_lost')) }
    }
    const interval = setInterval(() => { void renew() }, Math.max(1_000, Math.floor(this.options.leaseMs / 3)))
    interval.unref?.()
    try {
      const credential = await this.options.credentials.resolve(run.credentialReference, run.ownerId, run.outlineId)
      const tools = typeof this.options.tools === 'function' ? this.options.tools(run, credential) : this.options.tools
      const { result, turn } = await this.runEngine(run, credential, tools, controller.signal)
      await renew()
      if (leaseLost || controller.signal.aborted) throw controller.signal.reason ?? new Error('lease_lost')
      await this.options.repository.commitAgentResult(run.id, this.options.workerId, result, turn)
    } catch (error) {
      const current = await this.options.repository.agentStore.getRun(run.outlineId, run.id)
      if (!current || ['completed', 'failed', 'cancelled', 'interrupted'].includes(current.status)) return
      if (leaseLost) return
      if (isAbortError(error) || controller.signal.aborted) {
        try { await this.options.repository.agentStore.finishCancelled(run.id, this.options.workerId) } catch { /* lease may have moved */ }
        return
      }
      const classified = classifyRunFailure(error)
      const backoff = Math.min(this.options.maxBackoffMs ?? 300_000, 1_000 * (2 ** Math.max(0, run.attemptCount - 1)))
      try {
        await this.options.repository.agentStore.appendActivity(run.id, {
          id: `failure-${run.attemptCount}`, sequence: 1, phase: 'error', kind: 'error',
          label: classified.code.replaceAll('_', ' '), detail: classified.detail, status: 'error',
        })
        await this.options.repository.agentStore.fail(
          run.id, this.options.workerId, classified.code, classified.retryable, new Date(), backoff,
        )
      } catch (settleError) {
        if (!(settleError instanceof AgentStoreError && settleError.code === 'lease_lost')) throw settleError
      }
    } finally { clearInterval(interval) }
  }

  private async runEngine(
    run: AgentRunRecord, credential: ResolvedModelCredential, tools: RuntimeTool[], signal: AbortSignal,
  ): Promise<{ result: LocalRunResult; turn?: CallTurnEntries }> {
    const onActivity = async (event: ActivityEvent) => { await this.options.repository.agentStore.appendActivity(run.id, event) }
    if (this.options.engine === 'legacy') {
      // The previous engine keeps no transcripts, so it never runs a reply without its history.
      if ((run.input.thread?.turn ?? 1) > 1) throw new AgentRuntimeError('conversation_unavailable', CONVERSATION_UNAVAILABLE)
      if (!this.options.modelFactory) throw new Error('The legacy agent engine requires a model factory.')
      return { result: await runAgent(run.input, { model: this.options.modelFactory(credential, run), tools, onActivity }, { signal }) }
    }
    const model = this.options.piModelFactory
      ? await this.options.piModelFactory(credential, run)
      : await createServerPiModel(credential, run.input.agent.modelId)
    const conversation = await openCallConversation(this.options.repository.agentStore, run, this.options.conversationTempRoot)
    try {
      const result = await runServerPiTurn(run.input, {
        model, tools, onActivity, signal, ...(conversation ? { conversation: conversation.store } : {}),
      })
      return { result, ...(conversation ? { turn: settledTurnEntries(conversation.appendedEntries(), credential) } : {}) }
    } finally {
      await conversation?.dispose()
    }
  }
}

export function classifyRunFailure(error: unknown): { code: string; retryable: boolean; detail: string } {
  if (error instanceof ProviderError) return { code: error.code, retryable: error.retryable, detail: safeFailureDetail(error) }
  if (error instanceof CredentialServiceError) return { code: 'authentication_required', retryable: false, detail: safeFailureDetail(error) }
  if (error instanceof AgentRuntimeError) {
    if (error.code === 'required_tool_unavailable') return { code: 'unsupported_tool', retryable: false, detail: safeFailureDetail(error) }
    if (error.code === 'conversation_unavailable') return { code: 'conversation_unavailable', retryable: false, detail: safeFailureDetail(error) }
    return { code: 'invalid_output', retryable: false, detail: safeFailureDetail(error) }
  }
  return { code: 'dependency_unavailable', retryable: true, detail: safeFailureDetail(error) }
}

function safeFailureDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Agent execution failed.'
  return message
    .replace(/(?:sk-[A-Za-z0-9_-]+|Bearer\s+\S+)/gi, '[redacted]')
    .replace(/((?:refresh[_-]?token|access[_-]?token|api[_-]?key|device[_-]?code)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]')
    .trim().slice(0, 2_000) || 'Agent execution failed.'
}

function isAbortError(error: unknown): boolean { return error instanceof Error && error.name === 'AbortError' }

export interface ServerAgentWorkerOptions {
  store: ServerRepository['agentStore']
  runner: ServerAgentRunner
  workerId: string
  concurrency: number
  pollMs: number
  leaseMs: number
}

export class ServerAgentWorker {
  private stopping = false
  private loopPromise: Promise<void> | null = null
  private readonly active = new Set<Promise<void>>()
  private wakePoll: (() => void) | null = null
  constructor(private readonly options: ServerAgentWorkerOptions) {}

  start(): void {
    if (this.loopPromise) return
    this.stopping = false
    this.loopPromise = this.loop()
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.wakePoll?.()
    await this.loopPromise
    await Promise.allSettled([...this.active])
    this.loopPromise = null
  }

  async tick(): Promise<number> {
    let claimed = 0
    while (!this.stopping && this.active.size < Math.max(1, this.options.concurrency)) {
      const run = await this.options.store.claimNext(this.options.workerId, new Date(), this.options.leaseMs)
      if (!run) break
      claimed += 1
      let execution!: Promise<void>
      execution = this.options.runner.execute(run).finally(() => this.active.delete(execution))
      this.active.add(execution)
    }
    return claimed
  }

  private async loop(): Promise<void> {
    while (!this.stopping) {
      await this.tick()
      if (!this.stopping) await this.waitForPoll()
    }
  }

  private waitForPoll(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(finish, Math.max(10, this.options.pollMs))
      const worker = this
      function finish() {
        clearTimeout(timer)
        if (worker.wakePoll === finish) worker.wakePoll = null
        resolve()
      }
      this.wakePoll = finish
    })
  }
}
