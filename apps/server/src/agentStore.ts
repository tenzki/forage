import {
  activityEventSchema,
  portableAgentConfigurationSchema,
  supportedAgentConfigurationSchema,
  computeProfileSchema,
  migrateAgentConfiguration,
  runInputSchema,
  type ActivityEvent,
  type PortableAgentConfiguration,
  type SupportedAgentConfiguration,
  type ComputeProfile,
  type LocalAnswerResult,
  type RunInput,
  type RunStatus,
  type StructuredResult,
} from '@forage/agent-runtime'
import { automationPolicySetSchema, type AutomationPolicySet } from '@forage/protocol'

export class AgentStoreError extends Error {
  constructor(
    public readonly code:
      | 'conflict' | 'not_found' | 'lease_lost' | 'invalid_state'
      | 'call_busy' | 'conversation_too_large' | 'conversation_unavailable',
    message: string,
  ) {
    super(message)
    this.name = 'AgentStoreError'
  }
}

export interface PublishedConfiguration { configuration: PortableAgentConfiguration; publishedAt: string }
export interface PublishedComputeProfile { profile: ComputeProfile; updatedAt: string }
export interface PublishedAutomation { policies: AutomationPolicySet; publishedAt: string }
export interface AgentRunResult { firstRevision: number; lastRevision: number; rootNoteIds: string[] }

/** The transcript entries one settled turn appended, already redacted, and their stored size. */
export interface CallTurnEntries { entries: unknown[]; entryBytes: number }

/** The call's latest placed version, which a replacing revision removes. */
export interface CallVersion { runId: string; rootNoteIds: string[] }

export const CALL_BUSY_MESSAGE = 'This call is still working on a reply. Wait for it to finish, then reply again.'
export const CONVERSATION_TOO_LARGE_MESSAGE = 'This conversation is too long to continue. Run the skill again to start a new call.'
export const CONVERSATION_UNAVAILABLE_MESSAGE = "This conversation's history is no longer available. Run the skill again to start a new one."
export const TURN_CONFLICT_MESSAGE = 'This call already has a newer reply. Refresh the thread and reply again.'
export interface AgentRunRecord {
  id: string
  ownerId: string
  outlineId: string
  trigger: 'manual' | 'inbox_automation'
  triggerIdentity: string
  input: RunInput
  skillId: string
  policyId: string | null
  configurationRevision: number
  credentialReference: string
  status: RunStatus
  attemptCount: number
  maxAttempts: number
  availableAt: string
  leaseOwner: string | null
  leaseExpiresAt: string | null
  cancelRequestedAt: string | null
  errorCode: string | null
  retryOfRunId: string | null
  invocationId: string | null
  intentHash: string | null
  admittedAt: string
  updatedAt: string
  result: AgentRunResult | null
  placementError: string | null
  /** The call a manual run belongs to; the first run's ID is the call ID. */
  callId: string | null
  callTurn: number | null
  /** A reply's inline answer. */
  answer: string | null
}

export interface AdmitRunInput {
  input: RunInput
  trigger: AgentRunRecord['trigger']
  triggerIdentity: string
  policyId?: string
  maxAttempts: number
  retryOfRunId?: string
  ownerId?: string
  invocationId?: string
  intentHash?: string
  /** A reply is refused when the call's stored transcript already exceeds this many bytes. */
  conversationBudgetBytes?: number
}

export interface AgentStore {
  currentConfiguration(outlineId: string): Promise<PublishedConfiguration | null>
  publishConfiguration(outlineId: string, baseRevision: number, configuration: SupportedAgentConfiguration, publishedBy?: string): Promise<PublishedConfiguration>
  currentComputeProfile(outlineId: string): Promise<PublishedComputeProfile | null>
  publishComputeProfile(outlineId: string, baseRevision: number, profile: ComputeProfile, publishedBy?: string): Promise<PublishedComputeProfile>
  currentAutomation(outlineId: string): Promise<PublishedAutomation | null>
  publishAutomation(outlineId: string, baseRevision: number, policies: AutomationPolicySet, publishedBy?: string): Promise<PublishedAutomation>
  admitRun(admission: AdmitRunInput): Promise<AgentRunRecord>
  getRun(outlineId: string, runId: string): Promise<AgentRunRecord | null>
  listRuns(outlineId: string, limit: number, before?: string, status?: RunStatus): Promise<AgentRunRecord[]>
  activity(runId: string, afterSequence: number, limit: number): Promise<{ events: ActivityEvent[]; status: RunStatus }>
  appendActivity(runId: string, event: ActivityEvent): Promise<ActivityEvent>
  claimNext(workerId: string, now: Date, leaseMs: number): Promise<AgentRunRecord | null>
  renewLease(runId: string, workerId: string, now: Date, leaseMs: number): Promise<{ owned: boolean; cancelRequested: boolean }>
  requestCancellation(outlineId: string, runId: string, now: Date): Promise<AgentRunRecord>
  finishCancelled(runId: string, workerId: string): Promise<void>
  fail(runId: string, workerId: string, errorCode: string, retryable: boolean, now: Date, backoffMs: number): Promise<AgentRunRecord>
  /** Settle a placed run; a call's turn entries are stored in the same transaction. */
  complete(runId: string, workerId: string, resultIdentity: string, result: AgentRunResult, turn?: CallTurnEntries): Promise<AgentRunResult>
  persistOutput(runId: string, workerId: string, resultIdentity: string, result: StructuredResult): Promise<void>
  output(runId: string): Promise<{ resultIdentity: string; result: StructuredResult } | null>
  completeUnplaced(runId: string, workerId: string, reason: string, turn?: CallTurnEntries): Promise<void>
  /** Settle a reply that answered inline: store the answer, never placed, and the turn's entries. */
  completeAnswer(runId: string, workerId: string, answer: LocalAnswerResult, turn: CallTurnEntries): Promise<void>
  placeOutput(outlineId: string, runId: string, resultIdentity: string, result: AgentRunResult): Promise<AgentRunResult>
  retry(outlineId: string, runId: string, input: RunInput, maxAttempts: number): Promise<AgentRunRecord>
  /** The stored entries of a call's turns before `beforeTurn`, in order; empty when any turn is missing. */
  conversationEntries(callId: string, beforeTurn: number): Promise<unknown[]>
  latestCallVersion(outlineId: string, callId: string, beforeTurn: number): Promise<CallVersion | null>
  /**
   * Delete finished runs with their activity, outputs and transcripts. A call is
   * deleted only when all its runs are finished and none holds a retained unplaced result.
   */
  clearFinishedHistory(outlineId: string): Promise<number>
  /** Delete the transcripts of finished calls whose latest turn is older than `before`. */
  pruneConversations(before: Date): Promise<number>
}

interface StoredTurn { runId: string; outlineId: string; entries: unknown[]; entryBytes: number; createdAt: string }

interface StoredRun extends AgentRunRecord { resultIdentity: string | null }

export class InMemoryAgentStore implements AgentStore {
  private readonly configurations = new Map<string, PublishedConfiguration>()
  private readonly automations = new Map<string, PublishedAutomation>()
  private readonly computeProfiles = new Map<string, PublishedComputeProfile>()
  private readonly runs = new Map<string, StoredRun>()
  private readonly triggers = new Map<string, string>()
  private readonly activities = new Map<string, ActivityEvent[]>()
  private readonly outputs = new Map<string, { resultIdentity: string; result: StructuredResult }>()
  private readonly answers = new Map<string, string>()
  private readonly turns = new Map<string, Map<number, StoredTurn>>()

  async currentConfiguration(outlineId: string): Promise<PublishedConfiguration | null> {
    return cloneOrNull(this.configurations.get(outlineId))
  }

  async publishConfiguration(outlineId: string, baseRevision: number, raw: SupportedAgentConfiguration): Promise<PublishedConfiguration> {
    const configuration = normalizeConfiguration(raw)
    const current = this.configurations.get(outlineId)
    if ((current?.configuration.revision ?? 0) !== baseRevision || configuration.revision !== baseRevision + 1) {
      throw new AgentStoreError('conflict', 'Agent configuration revision conflict.')
    }
    const published = { configuration, publishedAt: new Date().toISOString() }
    this.configurations.set(outlineId, published)
    return structuredClone(published)
  }

  async currentComputeProfile(outlineId: string): Promise<PublishedComputeProfile | null> {
    return cloneOrNull(this.computeProfiles.get(outlineId))
  }

  async publishComputeProfile(outlineId: string, baseRevision: number, raw: ComputeProfile): Promise<PublishedComputeProfile> {
    const profile = computeProfileSchema.parse(structuredClone(raw))
    const current = this.computeProfiles.get(outlineId)
    if ((current?.profile.revision ?? 0) !== baseRevision || profile.revision !== baseRevision + 1) {
      throw new AgentStoreError('conflict', 'Compute profile revision conflict.')
    }
    const published = { profile, updatedAt: new Date().toISOString() }
    this.computeProfiles.set(outlineId, published)
    return structuredClone(published)
  }

  async currentAutomation(outlineId: string): Promise<PublishedAutomation | null> {
    return cloneOrNull(this.automations.get(outlineId))
  }

  async publishAutomation(outlineId: string, baseRevision: number, raw: AutomationPolicySet): Promise<PublishedAutomation> {
    const policies = automationPolicySetSchema.parse(structuredClone(raw))
    const current = this.automations.get(outlineId)
    if ((current?.policies.revision ?? 0) !== baseRevision || policies.revision !== baseRevision + 1) {
      throw new AgentStoreError('conflict', 'Automation policy revision conflict.')
    }
    const published = { policies, publishedAt: new Date().toISOString() }
    this.automations.set(outlineId, published)
    return structuredClone(published)
  }

  async admitRun(admission: AdmitRunInput): Promise<AgentRunRecord> {
    const input = runInputSchema.parse(structuredClone(admission.input))
    const triggerKey = `${input.outlineId}\0${admission.triggerIdentity}`
    const existingId = this.triggers.get(triggerKey)
    if (existingId) {
      const existing = this.runs.get(existingId)!
      if (admission.intentHash && existing.intentHash !== admission.intentHash) {
        throw new AgentStoreError('conflict', 'Invocation identifier was already used with different intent.')
      }
      return this.publicRun(existing)
    }
    if (this.runs.has(input.runId)) throw new AgentStoreError('conflict', 'Run identifier already exists.')
    if (input.thread) this.admitCallTurn(input, admission.conversationBudgetBytes)
    const now = new Date().toISOString()
    const run: StoredRun = {
      id: input.runId, outlineId: input.outlineId, trigger: admission.trigger,
      ownerId: admission.ownerId ?? 'owner-local',
      triggerIdentity: admission.triggerIdentity, input,
      skillId: input.skill.id, policyId: admission.policyId ?? null,
      configurationRevision: input.configurationRevision, credentialReference: input.credentialRef,
      status: 'queued', attemptCount: 0, maxAttempts: Math.max(1, Math.min(admission.maxAttempts, 20)),
      availableAt: now, leaseOwner: null, leaseExpiresAt: null, cancelRequestedAt: null,
      errorCode: null, retryOfRunId: admission.retryOfRunId ?? null,
      invocationId: admission.invocationId ?? null, intentHash: admission.intentHash ?? null,
      admittedAt: now, updatedAt: now, result: null, resultIdentity: null,
      placementError: null, callId: input.thread?.callId ?? null, callTurn: input.thread?.turn ?? null, answer: null,
    }
    this.runs.set(run.id, run)
    this.triggers.set(triggerKey, run.id)
    this.activities.set(run.id, [])
    return this.publicRun(run)
  }

  async getRun(outlineId: string, runId: string): Promise<AgentRunRecord | null> {
    const run = this.runs.get(runId)
    return run?.outlineId === outlineId ? this.publicRun(run) : null
  }

  async listRuns(outlineId: string, limit: number, before?: string, status?: RunStatus): Promise<AgentRunRecord[]> {
    return [...this.runs.values()]
      .filter((run) => run.outlineId === outlineId && (!status || run.status === status) && (!before || run.admittedAt < before))
      .sort((left, right) => right.admittedAt.localeCompare(left.admittedAt) || right.id.localeCompare(left.id))
      .slice(0, Math.max(1, Math.min(limit, 100)))
      .map((run) => this.publicRun(run))
  }

  async activity(runId: string, afterSequence: number, limit: number): Promise<{ events: ActivityEvent[]; status: RunStatus }> {
    const run = this.requireRun(runId)
    const events = (this.activities.get(runId) ?? []).filter((event) => event.sequence > afterSequence).slice(0, Math.max(1, Math.min(limit, 200)))
    return { events: structuredClone(events), status: run.status }
  }

  async appendActivity(runId: string, raw: ActivityEvent): Promise<ActivityEvent> {
    this.requireRun(runId)
    const events = this.activities.get(runId)!
    const event = activityEventSchema.parse({ ...structuredClone(raw), sequence: (events.at(-1)?.sequence ?? 0) + 1 })
    events.push(event)
    return structuredClone(event)
  }

  async claimNext(workerId: string, now: Date, leaseMs: number): Promise<AgentRunRecord | null> {
    const nowIso = now.toISOString()
    const ordered = [...this.runs.values()].sort((left, right) => left.availableAt.localeCompare(right.availableAt) || left.admittedAt.localeCompare(right.admittedAt))
    for (const run of ordered) {
      if (run.status === 'running' && run.leaseExpiresAt && run.leaseExpiresAt <= nowIso) {
        if (run.attemptCount >= run.maxAttempts) {
          this.terminal(run, 'failed', nowIso, 'attempts_exhausted')
          continue
        }
        run.status = 'retry_wait'
        run.availableAt = nowIso
        run.leaseOwner = null
        run.leaseExpiresAt = null
      }
      if (!['queued', 'retry_wait'].includes(run.status) || run.availableAt > nowIso) continue
      if (run.cancelRequestedAt) {
        this.terminal(run, 'cancelled', nowIso, null)
        continue
      }
      if (run.attemptCount >= run.maxAttempts) {
        this.terminal(run, 'failed', nowIso, 'attempts_exhausted')
        continue
      }
      run.status = 'running'
      run.attemptCount += 1
      run.leaseOwner = workerId
      run.leaseExpiresAt = new Date(now.getTime() + Math.max(1, leaseMs)).toISOString()
      run.updatedAt = nowIso
      return this.publicRun(run)
    }
    return null
  }

  async renewLease(runId: string, workerId: string, now: Date, leaseMs: number): Promise<{ owned: boolean; cancelRequested: boolean }> {
    const run = this.requireRun(runId)
    if (run.status !== 'running' || run.leaseOwner !== workerId || !run.leaseExpiresAt || run.leaseExpiresAt <= now.toISOString()) {
      return { owned: false, cancelRequested: Boolean(run.cancelRequestedAt) }
    }
    run.leaseExpiresAt = new Date(now.getTime() + Math.max(1, leaseMs)).toISOString()
    run.updatedAt = now.toISOString()
    return { owned: true, cancelRequested: Boolean(run.cancelRequestedAt) }
  }

  async requestCancellation(outlineId: string, runId: string, now: Date): Promise<AgentRunRecord> {
    const run = this.requireOutlineRun(outlineId, runId)
    if (isTerminal(run.status)) return this.publicRun(run)
    run.cancelRequestedAt ??= now.toISOString()
    run.updatedAt = now.toISOString()
    if (run.status === 'queued' || run.status === 'retry_wait') this.terminal(run, 'cancelled', now.toISOString(), null)
    return this.publicRun(run)
  }

  async finishCancelled(runId: string, workerId: string): Promise<void> {
    const run = this.requireLease(runId, workerId)
    this.terminal(run, 'cancelled', new Date().toISOString(), null)
  }

  async fail(runId: string, workerId: string, errorCode: string, retryable: boolean, now: Date, backoffMs: number): Promise<AgentRunRecord> {
    const run = this.requireLease(runId, workerId)
    if (run.cancelRequestedAt) this.terminal(run, 'cancelled', now.toISOString(), null)
    else if (retryable && run.attemptCount < run.maxAttempts) {
      run.status = 'retry_wait'; run.errorCode = errorCode
      run.availableAt = new Date(now.getTime() + Math.max(0, backoffMs)).toISOString()
      run.leaseOwner = null; run.leaseExpiresAt = null; run.updatedAt = now.toISOString()
    } else this.terminal(run, 'failed', now.toISOString(), run.attemptCount >= run.maxAttempts ? 'attempts_exhausted' : errorCode)
    return this.publicRun(run)
  }

  async complete(runId: string, workerId: string, resultIdentity: string, result: AgentRunResult, turn?: CallTurnEntries): Promise<AgentRunResult> {
    const run = this.requireRun(runId)
    if (run.result) {
      if (run.resultIdentity === resultIdentity && JSON.stringify(run.result) === JSON.stringify(result)) return structuredClone(run.result)
      throw new AgentStoreError('conflict', 'Run already has a different result.')
    }
    this.requireLease(runId, workerId)
    if (run.cancelRequestedAt) throw new AgentStoreError('invalid_state', 'Run cancellation was requested.')
    if (turn) this.storeTurn(run, turn)
    run.result = structuredClone(result); run.resultIdentity = resultIdentity
    this.terminal(run, 'completed', new Date().toISOString(), null)
    return structuredClone(result)
  }

  async persistOutput(runId: string, workerId: string, resultIdentity: string, result: StructuredResult): Promise<void> {
    const existing = this.outputs.get(runId)
    if (existing) {
      if (existing.resultIdentity === resultIdentity && JSON.stringify(existing.result) === JSON.stringify(result)) return
      if (existing.resultIdentity !== resultIdentity || this.requireRun(runId).status !== 'running') {
        throw new AgentStoreError('conflict', 'Run already has different persisted output.')
      }
    }
    // A later attempt of a run that was never settled replaces the earlier attempt's output.
    this.requireLease(runId, workerId)
    this.outputs.set(runId, { resultIdentity, result: structuredClone(result) })
  }

  async output(runId: string) {
    return cloneOrNull(this.outputs.get(runId))
  }

  async completeUnplaced(runId: string, workerId: string, reason: string, turn?: CallTurnEntries): Promise<void> {
    const run = this.requireLease(runId, workerId)
    if (!this.outputs.has(runId)) throw new AgentStoreError('invalid_state', 'Run output has not been persisted.')
    if (turn) this.storeTurn(run, turn)
    run.placementError = reason
    this.terminal(run, 'completed_unplaced', new Date().toISOString(), null)
  }

  async completeAnswer(runId: string, workerId: string, answer: LocalAnswerResult, turn: CallTurnEntries): Promise<void> {
    const run = this.requireLease(runId, workerId)
    if (run.cancelRequestedAt) throw new AgentStoreError('invalid_state', 'Run cancellation was requested.')
    this.storeTurn(run, turn)
    this.answers.set(runId, answer.text)
    run.answer = answer.text
    this.terminal(run, 'completed', new Date().toISOString(), null)
  }

  async conversationEntries(callId: string, beforeTurn: number): Promise<unknown[]> {
    const turns = this.turns.get(callId)
    const entries: unknown[] = []
    for (let turn = 1; turn < beforeTurn; turn += 1) {
      const stored = turns?.get(turn)
      if (!stored) return []
      entries.push(...structuredClone(stored.entries))
    }
    return entries
  }

  async latestCallVersion(outlineId: string, callId: string, beforeTurn: number): Promise<CallVersion | null> {
    const previous = [...this.runs.values()]
      .filter((run) => run.outlineId === outlineId && run.callId === callId && (run.callTurn ?? 0) < beforeTurn && run.result)
      .sort((left, right) => (right.callTurn ?? 0) - (left.callTurn ?? 0))[0]
    return previous?.result ? { runId: previous.id, rootNoteIds: [...previous.result.rootNoteIds] } : null
  }

  async clearFinishedHistory(outlineId: string): Promise<number> {
    const groups = new Map<string, StoredRun[]>()
    for (const run of this.runs.values()) {
      if (run.outlineId !== outlineId) continue
      const key = run.callId ?? run.id
      groups.set(key, [...(groups.get(key) ?? []), run])
    }
    let deleted = 0
    for (const [key, runs] of groups) {
      if (!runs.every((run) => isTerminal(run.status) && run.status !== 'completed_unplaced')) continue
      for (const run of runs) {
        this.runs.delete(run.id); this.activities.delete(run.id); this.outputs.delete(run.id); this.answers.delete(run.id)
        for (const [trigger, id] of this.triggers) if (id === run.id) this.triggers.delete(trigger)
        for (const other of this.runs.values()) if (other.retryOfRunId === run.id) other.retryOfRunId = null
        deleted += 1
      }
      this.turns.delete(key)
    }
    return deleted
  }

  async pruneConversations(before: Date): Promise<number> {
    let pruned = 0
    for (const [callId, turns] of this.turns) {
      const latest = [...turns.values()].reduce((max, turn) => (turn.createdAt > max ? turn.createdAt : max), '')
      const active = [...this.runs.values()].some((run) => run.callId === callId && !isTerminal(run.status))
      if (active || latest >= before.toISOString()) continue
      this.turns.delete(callId)
      pruned += turns.size
    }
    return pruned
  }

  async placeOutput(outlineId: string, runId: string, resultIdentity: string, result: AgentRunResult): Promise<AgentRunResult> {
    const run = this.requireOutlineRun(outlineId, runId)
    if (run.result) return structuredClone(run.result)
    if (run.status !== 'completed_unplaced') throw new AgentStoreError('invalid_state', 'Run output is not awaiting placement.')
    run.result = structuredClone(result)
    run.resultIdentity = resultIdentity
    run.placementError = null
    this.terminal(run, 'completed', new Date().toISOString(), null)
    return structuredClone(result)
  }

  async retry(outlineId: string, runId: string, input: RunInput, maxAttempts: number): Promise<AgentRunRecord> {
    const previous = this.requireOutlineRun(outlineId, runId)
    if (!['failed', 'cancelled', 'interrupted'].includes(previous.status)) {
      throw new AgentStoreError('invalid_state', 'Only failed, cancelled, or interrupted runs can be retried.')
    }
    return this.admitRun({
      input, trigger: previous.trigger, triggerIdentity: `retry:${previous.id}:${input.runId}`,
      policyId: previous.policyId ?? undefined, maxAttempts, retryOfRunId: previous.id,
    })
  }

  private admitCallTurn(input: RunInput, budgetBytes = Number.POSITIVE_INFINITY): void {
    const thread = input.thread!
    if (thread.turn === 1) {
      if (thread.callId !== input.runId) throw new AgentStoreError('conflict', 'A call starts with its first run as the call.')
      return
    }
    const root = this.runs.get(thread.callId)
    if (!root || root.outlineId !== input.outlineId || root.callId !== thread.callId) {
      throw new AgentStoreError('conversation_unavailable', CONVERSATION_UNAVAILABLE_MESSAGE)
    }
    if ([...this.runs.values()].some((run) => run.callId === thread.callId && !isTerminal(run.status))) {
      throw new AgentStoreError('call_busy', CALL_BUSY_MESSAGE)
    }
    const turns = [...(this.turns.get(thread.callId)?.values() ?? [])]
    requireNextTurn(thread.turn, turns.length, turns.reduce((total, turn) => total + turn.entryBytes, 0), budgetBytes)
  }

  private storeTurn(run: StoredRun, turn: CallTurnEntries): void {
    if (!run.callId || !run.callTurn) return
    const turns = this.turns.get(run.callId) ?? new Map<number, StoredTurn>()
    if (turns.has(run.callTurn)) throw new AgentStoreError('conflict', TURN_CONFLICT_MESSAGE)
    turns.set(run.callTurn, {
      runId: run.id, outlineId: run.outlineId, entries: structuredClone(turn.entries),
      entryBytes: turn.entryBytes, createdAt: new Date().toISOString(),
    })
    this.turns.set(run.callId, turns)
  }

  private requireRun(runId: string): StoredRun {
    const run = this.runs.get(runId)
    if (!run) throw new AgentStoreError('not_found', 'Run is unavailable.')
    return run
  }

  private requireOutlineRun(outlineId: string, runId: string): StoredRun {
    const run = this.requireRun(runId)
    if (run.outlineId !== outlineId) throw new AgentStoreError('not_found', 'Run is unavailable.')
    return run
  }

  private requireLease(runId: string, workerId: string): StoredRun {
    const run = this.requireRun(runId)
    if (run.status !== 'running' || run.leaseOwner !== workerId) throw new AgentStoreError('lease_lost', 'Worker no longer owns the run lease.')
    return run
  }

  private terminal(run: StoredRun, status: Extract<RunStatus, 'completed' | 'completed_unplaced' | 'failed' | 'cancelled'>, now: string, errorCode: string | null): void {
    run.status = status; run.errorCode = errorCode; run.leaseOwner = null; run.leaseExpiresAt = null; run.updatedAt = now
  }

  private publicRun(run: StoredRun): AgentRunRecord {
    const { resultIdentity: _resultIdentity, ...publicRun } = run
    return structuredClone(publicRun)
  }
}

function normalizeConfiguration(raw: SupportedAgentConfiguration): PortableAgentConfiguration {
  const cloned = structuredClone(raw)
  const portable = portableAgentConfigurationSchema.safeParse(cloned)
  if (portable.success) return portable.data
  return migrateAgentConfiguration(supportedAgentConfigurationSchema.parse(cloned)).configuration
}

/** Admission rules for a reply: the call has stored turns, this is the next one, and it is within budget. */
export function requireNextTurn(turn: number, storedTurns: number, storedBytes: number, budgetBytes: number): void {
  if (storedTurns === 0) throw new AgentStoreError('conversation_unavailable', CONVERSATION_UNAVAILABLE_MESSAGE)
  if (turn !== storedTurns + 1) throw new AgentStoreError('conflict', TURN_CONFLICT_MESSAGE)
  if (storedBytes > budgetBytes) throw new AgentStoreError('conversation_too_large', CONVERSATION_TOO_LARGE_MESSAGE)
}

export function isTerminal(status: RunStatus): boolean {
  return ['completed', 'completed_unplaced', 'failed', 'cancelled', 'interrupted'].includes(status)
}

function cloneOrNull<T>(value: T | undefined): T | null {
  return value === undefined ? null : structuredClone(value)
}
