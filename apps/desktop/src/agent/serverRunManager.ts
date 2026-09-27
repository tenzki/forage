import { invoke } from '@tauri-apps/api/core'
import type { RunStatus, RunThread } from '@forage/agent-runtime'
import type { ActivityEvent } from './activity'
import { fromRuntimeEvent, runActivityLabel } from './activityCalls'
import type { ServerInvocationIntent } from './serverExecutor'
import { TauriServerAgentTransport, type ServerAgentTransport } from './serverExecutor'
import { AGENT_POLL_MS, agentRunSignals, agentWaitMs, waitForAgentRunSignal, type AgentRunSignals } from './agentRunSignals'
import { streamLiveness, type StreamLivenessTracker } from '../sync/streamLiveness'
import { useSettingsStore } from '../store/settingsStore'

/**
 * A server run this device shows in the activity panel. Its activity call is keyed
 * by `invocationId`, the id the invoking surface used before the run was admitted.
 */
export interface RememberedServerRun {
  runId: string
  invocationId: string
  lastSequence: number
  status: RunStatus
  updatedAt: string
  label?: string
  /** Invocation bullet of a manual run. */
  nodeId?: string
  /** The call and turn of a manual run, once the server reports them. */
  thread?: RunThread
  /** A reply's text. */
  note?: string
  /** A reply's inline answer. */
  answer?: string
  /** Inbox automation runs are not calls and take no replies. */
  automation?: boolean
}

type ActivityListener = (event: ActivityEvent) => void | Promise<void>
type RunSummary = Awaited<ReturnType<ServerAgentTransport['runs']>>['runs'][number]

/** How the invoking surface labels a run it starts. */
export interface ServerRunPresentation {
  label: string
  note?: string
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

/** Whether a run is a call this panel shows: Inbox automation, or a manual run of a call. */
function isShownRun(run: RunSummary): boolean {
  return run.trigger === 'inbox_automation' || Boolean(run.callId)
}

const terminal = new Set<RunStatus>(['completed', 'completed_unplaced', 'failed', 'cancelled', 'interrupted'])

/** Owns remote observation independently of editor and popup component lifetimes. */
export class ServerRunManager {
  private readonly runs = new Map<string, RememberedServerRun>()
  private readonly observations = new Map<string, Promise<Awaited<ReturnType<ServerAgentTransport['run']>>>>()
  private readonly adopting = new Set<string>()
  /** Admissions in flight; adoption waits for them so this device's own runs are not adopted twice. */
  private readonly invoking = new Set<Promise<unknown>>()
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
    // Oldest first, so a call's turns join its thread in order.
    const runs = [...this.runs.values()].sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
    for (const run of runs) await this.report(run, onActivity)
    await Promise.all(runs.map((run) => this.replay(run, onActivity)))
    for (const run of runs) {
      if (!terminal.has(run.status)) void this.observe(run.runId, onActivity).catch(() => undefined)
    }
  }

  private async replay(run: RememberedServerRun, onActivity?: ActivityListener): Promise<void> {
    if (!onActivity) return
    try {
      const page = await this.transport.activity(run.runId, 0, 200)
      for (const event of page.events) await onActivity(fromRuntimeEvent(event, run.invocationId))
    } catch {
      // Offline or the run was purged: the header still shows its last known status.
    }
  }

  /**
   * Start a server run. A reply carries its call's `conversation` and joins that
   * call's thread; a first run joins once the server reports the call it started.
   */
  async invoke(
    intent: ServerInvocationIntent,
    onActivity?: ActivityListener,
    presentation?: ServerRunPresentation,
  ): Promise<ManagedServerRun> {
    const admission = this.transport.invoke(intent)
    this.invoking.add(admission)
    let admitted: Awaited<typeof admission>
    try {
      admitted = await admission
      this.runs.set(admitted.runId, {
        runId: admitted.runId, invocationId: intent.invocationId, lastSequence: 0,
        status: admitted.status, updatedAt: admitted.admittedAt, nodeId: intent.sourceNodeId,
        ...(presentation?.label ? { label: presentation.label } : {}),
        ...(presentation?.note ? { note: presentation.note } : {}),
        ...(intent.conversation ? { thread: intent.conversation } : {}),
      })
    } finally {
      this.invoking.delete(admission)
    }
    await this.persist()
    return {
      runId: admitted.runId,
      completion: this.observe(admitted.runId, onActivity),
      cancel: () => this.transport.cancel(admitted.runId),
    }
  }

  resume(onActivity?: ActivityListener): Promise<void> {
    return this.restore(onActivity)
  }

  /** Show a run another device or the server started: Inbox automation, or a turn of a call. */
  async adopt(runId: string): Promise<void> {
    if (!this.listener || this.runs.has(runId) || this.adopting.has(runId)) return
    this.adopting.add(runId)
    try {
      const run = await this.transport.run(runId)
      await Promise.allSettled([...this.invoking])
      if (isShownRun(run) && !this.runs.has(runId)) await this.track(run)
    } finally {
      this.adopting.delete(runId)
    }
  }

  async adoptActive(): Promise<void> {
    if (!this.listener) return
    const page = await this.transport.runs(undefined, 20)
    await Promise.allSettled([...this.invoking])
    // Oldest first, so a call's turns join its thread in order.
    for (const run of [...page.runs].reverse()) {
      if (isShownRun(run) && !terminal.has(run.status) && !this.runs.has(run.id)) await this.track(run)
    }
  }

  private async track(run: RunSummary): Promise<void> {
    const skill = this.options.skillLabel?.(run.skillId) ?? run.skillId
    const reply = Boolean(run.turn && run.turn > 1)
    const remembered: RememberedServerRun = {
      runId: run.id, invocationId: run.id, lastSequence: 0, status: run.status, updatedAt: run.updatedAt,
      ...(run.trigger === 'inbox_automation' ? { label: `Inbox /${skill}`, automation: true } : {
        label: runActivityLabel(skill, reply ? '' : run.prompt ?? ''),
        ...(run.sourceNodeId ? { nodeId: run.sourceNodeId } : {}),
        ...(run.callId && run.turn ? { thread: { callId: run.callId, turn: run.turn } } : {}),
        ...(reply && run.prompt ? { note: run.prompt } : {}),
      }),
    }
    this.runs.set(run.id, remembered)
    await this.persist()
    await this.report(remembered, this.listener)
    void this.observe(run.id, this.listener).catch(() => undefined)
  }

  remembered(): RememberedServerRun[] {
    return [...this.runs.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  /**
   * Forget finished runs. With `server`, the server also deletes the outline's
   * finished calls and their transcripts, for every bound device.
   */
  async clearFinishedHistory(options: { server?: boolean } = {}): Promise<void> {
    if (options.server) await this.transport.clearHistory()
    for (const [runId, run] of this.runs) {
      if (terminal.has(run.status)) this.runs.delete(runId)
    }
    await this.persist()
  }

  /** The run's call header and, once it wrote to the outline, its output entry. */
  private async report(run: RememberedServerRun, onActivity?: ActivityListener): Promise<void> {
    await onActivity?.(runStatusEvent(run))
    if (run.status === 'completed' && run.nodeId && !run.answer) {
      await onActivity?.({
        id: `outline-${run.invocationId}`, callId: run.invocationId, phase: 'complete', kind: 'output',
        label: 'Outline updated', nodeId: run.nodeId,
      })
    }
  }

  private observe(runId: string, onActivity?: ActivityListener) {
    const existing = this.observations.get(runId)
    if (existing) return existing
    const observation = this.poll(runId, onActivity).finally(() => this.observations.delete(runId))
    this.observations.set(runId, observation)
    return observation
  }

  private async poll(runId: string, onActivity?: ActivityListener) {
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
      const invocationId = remembered?.invocationId ?? runId
      let sequence = remembered?.lastSequence ?? 0
      for (const event of page.events) {
        sequence = Math.max(sequence, event.sequence)
        await onActivity?.(fromRuntimeEvent(event, invocationId))
      }
      // The server's call and turn are authoritative; a server without calls reports none.
      const thread = run.callId && run.turn ? { callId: run.callId, turn: run.turn } : remembered?.thread
      const updated: RememberedServerRun = {
        ...remembered,
        runId,
        invocationId,
        lastSequence: sequence,
        status: run.status,
        updatedAt: run.updatedAt,
        ...(thread ? { thread } : {}),
        ...(run.answer ? { answer: run.answer } : {}),
      }
      this.runs.set(runId, updated)
      await this.persist()
      await this.report(updated, onActivity)
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

/**
 * The call-level event for a run. A call's turn keeps its skill label so it stays in
 * its thread; other runs show their status.
 */
function runStatusEvent(run: RememberedServerRun): ActivityEvent {
  const isFailure = run.status === 'failed'
  const isCancelled = run.status === 'cancelled' || run.status === 'interrupted'
  const isTerminal = terminal.has(run.status)
  const status = isFailure ? 'error' : isCancelled ? 'cancelled' : isTerminal ? 'complete' : 'running'
  return {
    id: run.invocationId,
    callId: run.invocationId,
    phase: status === 'running' ? 'start' : status,
    kind: run.thread ? 'skill' : isFailure ? 'error' : 'thinking',
    label: run.status === 'completed_unplaced' && !run.thread
      ? 'Completed — placement needed'
      : run.label ?? `Server run ${run.status.split('_').join(' ')}`,
    status,
    ...(run.nodeId ? { nodeId: run.nodeId } : {}),
    ...(run.thread ? { thread: run.thread } : {}),
    ...(run.note ? { note: run.note } : {}),
    ...(run.answer ? { answer: run.answer } : {}),
    ...(run.automation ? { automation: true } : {}),
  }
}

export const serverRunManager = new ServerRunManager(
  new TauriServerAgentTransport(),
  new NativeServerRunMemory(),
  { skillLabel: (skillId) => useSettingsStore.getState().skills.find((skill) => skill.id === skillId)?.label },
)
