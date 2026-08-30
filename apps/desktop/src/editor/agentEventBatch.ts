import { parseEventEnvelope, type EventEnvelope } from '@forage/domain'

type StepsEvent = Extract<EventEnvelope, { type: 'document.steps_applied' }>

/** Combines sequential agent deltas into one bounded durable editor event. */
export function mergeAgentDocumentEvents(events: readonly StepsEvent[]): StepsEvent {
  if (events.length === 0) throw new Error('Cannot merge an empty agent event batch.')
  if (events.length === 1) return events[0]
  const first = events[0]
  const last = events[events.length - 1]
  const steps = events.flatMap((event) => event.payload.steps)
  const inverseSteps = [...events].reverse().flatMap((event) => event.payload.inverseSteps)
  if (steps.length > 1_000) throw new Error('Agent event batch exceeds the step limit.')
  return parseEventEnvelope({
    ...first,
    occurredAt: last.occurredAt,
    payload: {
      steps,
      inverseSteps,
      beforeHash: first.payload.beforeHash,
      afterHash: last.payload.afterHash,
    },
  }) as StepsEvent
}
