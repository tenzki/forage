import { invoke } from '@tauri-apps/api/core'
import type { ActivityEvent, RunStatus } from '@forage/agent-runtime'
import type { ServerInvocationIntent } from './serverExecutor'
import { TauriServerAgentTransport, type ServerAgentTransport } from './serverExecutor'

export interface RememberedServerRun {
  runId: string
  invocationId: string
  lastSequence: number
  status: RunStatus
  updatedAt: string
}

export interface ServerRunMemory {
  load(): Promise<RememberedServerRun[]>
  save(runs: RememberedServerRun[]): Promise<void>
}

class NativeServerRunMemory implements ServerRunMemory {
  async load(): Promise<RememberedServerRun[]> {
    const value = await invoke<unknown | null>('server_agent_remembered_runs')
    if (!Array.isArray(value)) return []
    return value.filter((candidate): candidate is RememberedServerRun => {
      if (!candidate || typeof candidate !== 'object') return false
      const run = candidate as Partial<RememberedServerRun>
      return typeof run.runId === 'string' && typeof run.invocationId === 'string'
        && typeof run.lastSequence === 'number' && typeof run.status === 'string'
        && typeof run.updatedAt === 'string'
    })
  }
  async save(runs: RememberedServerRun[]): Promise<void> {
    await invoke('server_agent_set_remembered_runs', { runs })
  }
}

export interface ManagedServerRun {
  runId: string
  completion: Promise<Awaited<ReturnType<ServerAgentTransport['run']>>>
  cancel(): Promise<void>
}

const terminal = new Set<RunStatus>(['completed', 'completed_unplaced', 'failed', 'cancelled', 'interrupted'])

/** Owns remote observation independently of editor and popup component lifetimes. */
export class ServerRunManager {
  private readonly runs = new Map<string, RememberedServerRun>()
  private readonly observations = new Map<string, Promise<Awaited<ReturnType<ServerAgentTransport['run']>>>>()

  constructor(
    private readonly transport: ServerAgentTransport,
    private readonly memory: ServerRunMemory,
    private readonly options: { pollMs?: number; delay?: (milliseconds: number) => Promise<void> } = {},
  ) {}

  async restore(onActivity?: (event: ActivityEvent, runId: string) => void | Promise<void>): Promise<void> {
    for (const run of await this.memory.load()) this.runs.set(run.runId, run)
    for (const run of this.runs.values()) {
      await onActivity?.(runStatusEvent(run), run.runId)
      if (!terminal.has(run.status)) void this.observe(run.runId, onActivity).catch(() => undefined)
    }
  }

  async invoke(
    intent: ServerInvocationIntent,
    onActivity?: (event: ActivityEvent, runId: string) => void | Promise<void>,
  ): Promise<ManagedServerRun> {
    const admitted = await this.transport.invoke(intent)
    this.runs.set(admitted.runId, {
      runId: admitted.runId, invocationId: intent.invocationId, lastSequence: 0,
      status: admitted.status, updatedAt: admitted.admittedAt,
    })
    await this.persist()
    return {
      runId: admitted.runId,
      completion: this.observe(admitted.runId, onActivity),
      cancel: () => this.transport.cancel(admitted.runId),
    }
  }

  resume(onActivity?: (event: ActivityEvent, runId: string) => void | Promise<void>): Promise<void> {
    return this.restore(onActivity)
  }

  remembered(): RememberedServerRun[] {
    return [...this.runs.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  private observe(runId: string, onActivity?: (event: ActivityEvent, runId: string) => void | Promise<void>) {
    const existing = this.observations.get(runId)
    if (existing) return existing
    const observation = this.poll(runId, onActivity).finally(() => this.observations.delete(runId))
    this.observations.set(runId, observation)
    return observation
  }

  private async poll(runId: string, onActivity?: (event: ActivityEvent, runId: string) => void | Promise<void>) {
    const delay = this.options.delay ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
    for (;;) {
      const remembered = this.runs.get(runId)
      let page: Awaited<ReturnType<ServerAgentTransport['activity']>>
      let run: Awaited<ReturnType<ServerAgentTransport['run']>>
      try {
        page = await this.transport.activity(runId, remembered?.lastSequence ?? 0, 100)
        run = await this.transport.run(runId)
      } catch {
        // The run remains remote and durable while the desktop is offline or
        // deliberately disconnected. Keep observing so reconnect needs no UI owner.
        await delay(Math.max(250, this.options.pollMs ?? 1_000))
        continue
      }
      let sequence = remembered?.lastSequence ?? 0
      for (const event of page.events) {
        sequence = Math.max(sequence, event.sequence)
        await onActivity?.(event, runId)
      }
      this.runs.set(runId, {
        runId,
        invocationId: remembered?.invocationId ?? runId,
        lastSequence: sequence,
        status: run.status,
        updatedAt: run.updatedAt,
      })
      await this.persist()
      await onActivity?.(runStatusEvent(this.runs.get(runId)!), runId)
      if (terminal.has(run.status)) return run
      await delay(Math.max(0, this.options.pollMs ?? 1_000))
    }
  }

  private persist(): Promise<void> { return this.memory.save(this.remembered()) }
}

function runStatusEvent(run: RememberedServerRun): ActivityEvent {
  const isFailure = run.status === 'failed'
  const isCancelled = run.status === 'cancelled' || run.status === 'interrupted'
  const isTerminal = terminal.has(run.status)
  return {
    id: run.runId,
    callId: run.runId,
    sequence: Math.max(1, run.lastSequence + 1),
    phase: isFailure ? 'error' : isCancelled ? 'cancelled' : isTerminal ? 'complete' : 'progress',
    kind: isFailure ? 'error' : 'status',
    label: run.status === 'completed_unplaced' ? 'Completed — placement needed' : `Server run ${run.status.split('_').join(' ')}`,
    status: isFailure ? 'error' : isCancelled ? 'cancelled' : isTerminal ? 'success' : 'running',
    createdAt: run.updatedAt,
  }
}

export const serverRunManager = new ServerRunManager(
  new TauriServerAgentTransport(),
  new NativeServerRunMemory(),
)
