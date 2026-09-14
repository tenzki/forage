import { invoke } from '@tauri-apps/api/core'
import type { ActivityEvent, RunStatus } from '@forage/agent-runtime'
import type { ServerInvocationIntent } from './serverExecutor'
import { TauriServerAgentTransport, type ServerAgentTransport } from './serverExecutor'
import { AGENT_POLL_MS, agentRunSignals, agentWaitMs, waitForAgentRunSignal, type AgentRunSignals } from './agentRunSignals'
import { streamLiveness, type StreamLivenessTracker } from '../sync/streamLiveness'
import { useSettingsStore } from '../store/settingsStore'

export interface RememberedServerRun {
  runId: string
  invocationId: string
  lastSequence: number
  status: RunStatus
  updatedAt: string
  label?: string
}

type ActivityListener = (event: ActivityEvent, runId: string) => void | Promise<void>
type RunSummary = Awaited<ReturnType<ServerAgentTransport['runs']>>['runs'][number]

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
  private readonly adopting = new Set<string>()
  private listener: ActivityListener | undefined

  constructor(
    private readonly transport: ServerAgentTransport,
    private readonly memory: ServerRunMemory,
    private readonly options: {
      pollMs?: number
      delay?: (milliseconds: number) => Promise<void>
      signals?: AgentRunSignals
      liveness?: StreamLivenessTracker
      skillLabel?: (skillId: string) => string | undefined
    } = {},
  ) {}

  private waitMs(): number {
    return this.options.pollMs ?? agentWaitMs((this.options.liveness ?? streamLiveness).get())
  }

  async restore(onActivity?: ActivityListener): Promise<void> {
    if (onActivity) this.listener = onActivity
    for (const run of await this.memory.load()) this.runs.set(run.runId, run)
    const runs = [...this.runs.values()]
    for (const run of runs) await onActivity?.(runStatusEvent(run), run.runId)
    await Promise.all(runs.map((run) => this.replay(run.runId, onActivity)))
    for (const run of runs) {
      if (!terminal.has(run.status)) void this.observe(run.runId, onActivity).catch(() => undefined)
    }
  }

  private async replay(runId: string, onActivity?: ActivityListener): Promise<void> {
    if (!onActivity) return
    try {
      const page = await this.transport.activity(runId, 0, 200)
      for (const event of page.events) await onActivity(event, runId)
    } catch {
      // Offline or the run was purged: the header still shows its last known status.
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

  async adopt(runId: string): Promise<void> {
    if (!this.listener || this.runs.has(runId) || this.adopting.has(runId)) return
    this.adopting.add(runId)
    try {
      const run = await this.transport.run(runId)
      if (run.trigger === 'inbox_automation' && !this.runs.has(runId)) await this.track(run)
    } finally {
      this.adopting.delete(runId)
    }
  }

  async adoptActive(): Promise<void> {
    if (!this.listener) return
    const page = await this.transport.runs(undefined, 20)
    for (const run of page.runs) {
      if (run.trigger === 'inbox_automation' && !terminal.has(run.status) && !this.runs.has(run.id)) await this.track(run)
    }
  }

  private async track(run: RunSummary): Promise<void> {
    const remembered: RememberedServerRun = {
      runId: run.id, invocationId: run.id, lastSequence: 0, status: run.status, updatedAt: run.updatedAt,
      label: `Inbox /${this.options.skillLabel?.(run.skillId) ?? run.skillId}`,
    }
    this.runs.set(run.id, remembered)
    await this.persist()
    await this.listener?.(runStatusEvent(remembered), run.id)
    void this.observe(run.id, this.listener).catch(() => undefined)
  }

  remembered(): RememberedServerRun[] {
    return [...this.runs.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  async clearFinishedHistory(): Promise<void> {
    for (const [runId, run] of this.runs) {
      if (terminal.has(run.status)) this.runs.delete(runId)
    }
    await this.persist()
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
        await delay(Math.max(250, this.options.pollMs ?? AGENT_POLL_MS))
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
        ...(remembered?.label ? { label: remembered.label } : {}),
      })
      await this.persist()
      await onActivity?.(runStatusEvent(this.runs.get(runId)!), runId)
      if (terminal.has(run.status)) return run
      await waitForAgentRunSignal(
        this.options.signals ?? agentRunSignals,
        runId,
        delay(Math.max(0, this.waitMs())),
      )
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
    label: run.status === 'completed_unplaced' ? 'Completed — placement needed' : run.label ?? `Server run ${run.status.split('_').join(' ')}`,
    status: isFailure ? 'error' : isCancelled ? 'cancelled' : isTerminal ? 'success' : 'running',
    createdAt: run.updatedAt,
  }
}

export const serverRunManager = new ServerRunManager(
  new TauriServerAgentTransport(),
  new NativeServerRunMemory(),
  { skillLabel: (skillId) => useSettingsStore.getState().skills.find((skill) => skill.id === skillId)?.label },
)
