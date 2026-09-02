import {
  parseStructuredResult,
  runInputSchema,
  type ActivityEvent,
  type RunInput,
  type RunStatus,
  type StructuredResult,
} from '@forage/agent-runtime'
import type { LocalAgentActivity, LocalAgentRun } from '../persistence/eventStore'

export interface LocalRunRepository {
  admitAgentRun(run: LocalAgentRun): Promise<void>
  agentRun(runId: string): Promise<LocalAgentRun | null>
  beginAgentAttempt(runId: string, startedAt: string): Promise<number>
  appendAgentActivity(runId: string, event: ActivityEvent, createdAt: string): Promise<number>
  agentActivityAfter(runId: string, afterSequence: number, limit?: number): Promise<LocalAgentActivity[]>
  cancelAgentRun(runId: string, cancelledAt: string): Promise<void>
  settleAgentRun(
    runId: string,
    status: Extract<RunStatus, 'completed' | 'failed' | 'cancelled' | 'interrupted'>,
    resultIdentity: string | null,
    result: StructuredResult | null,
    errorCode: string | null,
    settledAt: string,
  ): Promise<void>
  retryAgentRun(originalRunId: string, run: LocalAgentRun): Promise<void>
}

export type LocalRuntimeRunner = (
  input: RunInput,
  options: { signal: AbortSignal; onActivity: (event: ActivityEvent) => Promise<void> },
) => Promise<StructuredResult>

export interface AgentExecutionHandle {
  runId: string
  completion: Promise<StructuredResult>
  cancel: () => Promise<void>
}

export interface AgentInvocationOptions {
  onActivity?: (event: ActivityEvent) => void | Promise<void>
}

export class LocalAgentExecutor {
  private readonly active = new Map<string, AbortController>()

  constructor(
    private readonly repository: LocalRunRepository,
    private readonly runner: LocalRuntimeRunner,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async invoke(rawInput: RunInput, options: AgentInvocationOptions = {}): Promise<AgentExecutionHandle> {
    const input = this.localInput(rawInput)
    await this.repository.admitAgentRun(this.runRecord(input, null))
    return this.start(input, options)
  }

  async retry(originalRunId: string, rawInput: RunInput, options: AgentInvocationOptions = {}): Promise<AgentExecutionHandle> {
    const input = this.localInput(rawInput)
    await this.repository.retryAgentRun(originalRunId, this.runRecord(input, originalRunId))
    return this.start(input, options)
  }

  observe(runId: string, afterSequence: number, limit = 100): Promise<LocalAgentActivity[]> {
    return this.repository.agentActivityAfter(runId, afterSequence, limit)
  }

  run(runId: string): Promise<LocalAgentRun | null> {
    return this.repository.agentRun(runId)
  }

  async cancel(runId: string): Promise<void> {
    await this.repository.cancelAgentRun(runId, this.now())
    this.active.get(runId)?.abort('user_cancelled')
  }

  private localInput(rawInput: RunInput): RunInput {
    const input = runInputSchema.parse(rawInput)
    if (input.executionMode !== 'local') {
      throw new Error('LocalAgentExecutor accepts only local execution snapshots.')
    }
    return input
  }

  private runRecord(input: RunInput, retryOfRunId: string | null): LocalAgentRun {
    const timestamp = this.now()
    return {
      id: input.runId,
      outlineId: input.outlineId,
      snapshot: input,
      status: 'queued',
      attemptCount: 0,
      resultIdentity: null,
      result: null,
      retryOfRunId,
      cancelRequestedAt: null,
      errorCode: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    }
  }

  private start(input: RunInput, options: AgentInvocationOptions): AgentExecutionHandle {
    const controller = new AbortController()
    this.active.set(input.runId, controller)
    const completion = this.execute(input, controller, options).finally(() => {
      if (this.active.get(input.runId) === controller) this.active.delete(input.runId)
    })
    return {
      runId: input.runId,
      completion,
      cancel: () => this.cancel(input.runId),
    }
  }

  private async execute(
    input: RunInput,
    controller: AbortController,
    options: AgentInvocationOptions,
  ): Promise<StructuredResult> {
    await this.repository.beginAgentAttempt(input.runId, this.now())
    try {
      const result = parseStructuredResult(await this.runner(input, {
        signal: controller.signal,
        onActivity: async (event) => {
          await this.repository.appendAgentActivity(input.runId, event, this.now())
          await options.onActivity?.(event)
        },
      }))
      if (controller.signal.aborted) throw new DOMException('Agent run cancelled.', 'AbortError')
      await this.repository.settleAgentRun(
        input.runId,
        'completed',
        `result:${input.runId}`,
        result,
        null,
        this.now(),
      )
      return result
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        await this.repository.settleAgentRun(input.runId, 'cancelled', null, null, null, this.now())
        throw new DOMException('Agent run cancelled.', 'AbortError')
      }
      await this.repository.settleAgentRun(
        input.runId,
        'failed',
        null,
        null,
        'execution_failed',
        this.now(),
      )
      throw error
    }
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}
