import { AgentRuntimeError, runAgent, type ModelAdapter, type RuntimeTool } from '@forage/agent-runtime'
import type { AgentRunRecord } from './agentStore.js'
import { AgentStoreError } from './agentStore.js'
import type { ServerCredentialService, ResolvedModelCredential } from './credentialService.js'
import { CredentialServiceError } from './credentialService.js'
import { ProviderError } from './transcript.js'
import type { ServerRepository } from './repository.js'

export interface ServerAgentRunnerOptions {
  repository: ServerRepository
  credentials: ServerCredentialService
  tools: RuntimeTool[] | ((run: AgentRunRecord, credential: ResolvedModelCredential) => RuntimeTool[])
  workerId: string
  leaseMs: number
  maxBackoffMs?: number
  modelFactory: (credential: ResolvedModelCredential, run: AgentRunRecord) => ModelAdapter
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
      const result = await runAgent(run.input, {
        model: this.options.modelFactory(credential, run),
        tools,
        onActivity: async (event) => { await this.options.repository.agentStore.appendActivity(run.id, event) },
      }, { signal: controller.signal })
      await renew()
      if (leaseLost || controller.signal.aborted) throw controller.signal.reason ?? new Error('lease_lost')
      await this.options.repository.commitAgentResult(run.id, this.options.workerId, result)
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
          label: classified.code.replaceAll('_', ' '), status: 'error',
        })
        await this.options.repository.agentStore.fail(
          run.id, this.options.workerId, classified.code, classified.retryable, new Date(), backoff,
        )
      } catch (settleError) {
        if (!(settleError instanceof AgentStoreError && settleError.code === 'lease_lost')) throw settleError
      }
    } finally { clearInterval(interval) }
  }
}

export function classifyRunFailure(error: unknown): { code: string; retryable: boolean } {
  if (error instanceof ProviderError) return { code: error.code, retryable: error.retryable }
  if (error instanceof CredentialServiceError) return { code: 'authentication_required', retryable: false }
  if (error instanceof AgentRuntimeError) {
    if (error.code === 'required_tool_unavailable') return { code: 'unsupported_tool', retryable: false }
    return { code: 'invalid_output', retryable: false }
  }
  return { code: 'dependency_unavailable', retryable: true }
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
