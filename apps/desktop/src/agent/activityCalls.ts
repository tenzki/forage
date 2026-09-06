import type { ActivityEvent as RuntimeActivityEvent } from '@forage/agent-runtime'
import type { ActivityCall, ActivityEntry, ActivityStatus } from '../components/Agent/ActivitySidebar'
import type { ActivityEvent } from './activity'
import type { LocalAgentRunHistory } from '../persistence/eventStore'

/** Newest calls are kept; older ones fall off the sidebar. */
export const MAX_ACTIVITY_CALLS = 100

function phaseStatus(event: ActivityEvent): ActivityStatus {
  if (event.status) return event.status
  if (event.phase === 'start') return 'running'
  if (event.phase === 'error') return 'error'
  if (event.phase === 'cancelled') return 'cancelled'
  return 'complete'
}

/**
 * Fold one activity event into the call list. Every event of a run carries the run's
 * `callId`, so a run always renders as a single collapsible call with its own timeline.
 */
export function applyActivityEvent(
  calls: ActivityCall[],
  event: ActivityEvent,
  now: number = Date.now(),
): ActivityCall[] {
  const status = phaseStatus(event)
  const callId = event.callId ?? event.id
  const isCallEvent = event.id === callId
  const existingCall = calls.find((call) => call.id === callId)
  const existingEvent = existingCall?.events.find((entry) => entry.id === event.id)
  const nextEvent: ActivityEntry = {
    id: event.id,
    kind: event.kind,
    label: event.label,
    detail: event.detail ?? existingEvent?.detail,
    status,
    timestamp: existingEvent?.timestamp ?? now,
    durationMs: event.durationMs ?? existingEvent?.durationMs,
    nodeId: event.nodeId ?? existingEvent?.nodeId,
  }
  // The call-level event is the header, never a timeline row of its own.
  if (!existingCall) {
    return [...calls, {
      id: callId,
      ...(isCallEvent ? { kind: event.kind } : {}),
      label: isCallEvent ? event.label : 'Agent execution',
      detail: isCallEvent ? event.detail : undefined,
      status: isCallEvent ? status : 'running',
      timestamp: now,
      durationMs: isCallEvent ? event.durationMs : undefined,
      nodeId: isCallEvent ? event.nodeId : undefined,
      events: isCallEvent ? [] : [nextEvent],
    }].slice(-MAX_ACTIVITY_CALLS)
  }
  const events = isCallEvent
    ? existingCall.events
    : existingEvent
      ? existingCall.events.map((entry) => entry.id === event.id ? { ...entry, ...nextEvent } : entry)
      : [...existingCall.events, nextEvent]
  return calls.map((call) => call.id === callId
    ? {
        ...call,
        kind: isCallEvent ? event.kind : call.kind,
        label: isCallEvent ? event.label : call.label,
        detail: isCallEvent ? event.detail ?? call.detail : call.detail,
        status: isCallEvent ? status : call.status,
        durationMs: isCallEvent ? event.durationMs ?? call.durationMs : call.durationMs,
        nodeId: isCallEvent ? event.nodeId ?? call.nodeId : call.nodeId,
        events,
      }
    : call)
}

/** Translate a runtime activity event into the sidebar vocabulary, grouped under its run. */
export function fromRuntimeEvent(event: RuntimeActivityEvent, callId: string): ActivityEvent {
  return {
    id: event.id,
    callId: event.callId ?? callId,
    phase: event.phase === 'progress' ? 'start' : event.phase,
    kind: event.kind === 'status' ? 'thinking' : event.kind,
    label: event.label,
    ...(event.detail ? { detail: event.detail } : {}),
    ...(event.nodeId ? { nodeId: event.nodeId } : {}),
    ...(event.durationMs === undefined ? {} : { durationMs: event.durationMs }),
    ...(event.status ? {
      status: event.status === 'success' ? 'complete'
        : event.status === 'pending' ? 'running'
          : event.status,
    } : {}),
  }
}

export function runActivityLabel(skillLabel: string, prompt: string): string {
  const trimmed = prompt.trim()
  return `Run /${skillLabel}${trimmed ? ` ${trimmed}` : ''}`
}

function runStatus(run: LocalAgentRunHistory['run']): ActivityStatus {
  if (run.status === 'completed') return 'complete'
  if (run.status === 'failed') return 'error'
  if (run.status === 'cancelled' || run.status === 'interrupted') return 'cancelled'
  return 'running'
}

function timestamp(value: string, fallback: number): number {
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? fallback : parsed
}

/**
 * Rebuild sidebar calls from persisted runs so activity survives an app restart.
 * The run row is the call header; its stored events become the timeline.
 */
export function callsFromHistory(history: LocalAgentRunHistory[], now: number = Date.now()): ActivityCall[] {
  const oldestFirst = [...history].sort(
    (left, right) => timestamp(left.run.createdAt, now) - timestamp(right.run.createdAt, now),
  )
  return oldestFirst.reduce<ActivityCall[]>((calls, entry) => {
    const startedAt = timestamp(entry.run.createdAt, now)
    const settledAt = timestamp(entry.run.updatedAt, startedAt)
    const status = runStatus(entry.run)
    const withCall = applyActivityEvent(calls, {
      id: entry.run.id,
      phase: 'complete',
      kind: 'skill',
      label: runActivityLabel(entry.run.snapshot.skill.label, entry.run.snapshot.prompt),
      detail: entry.run.snapshot.prompt || undefined,
      status,
      nodeId: entry.run.snapshot.source.nodeId,
      ...(status === 'running' ? {} : { durationMs: Math.max(0, settledAt - startedAt) }),
    }, startedAt)
    return entry.activity.reduce(
      (accumulated, record) => record.event.id === entry.run.id
        ? accumulated
        : applyActivityEvent(
            accumulated,
            fromRuntimeEvent(record.event, entry.run.id),
            timestamp(record.createdAt, startedAt),
          ),
      withCall,
    )
  }, [])
}
