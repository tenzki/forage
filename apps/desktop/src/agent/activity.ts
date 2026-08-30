import type { ActivityKind, ActivityStatus } from '../components/Agent/ActivitySidebar'

export type ActivityPhase = 'start' | 'complete' | 'error' | 'cancelled'

export interface ActivityEvent {
  id: string
  callId?: string
  phase: ActivityPhase
  kind: ActivityKind
  label: string
  detail?: string
  status?: ActivityStatus
  durationMs?: number
}

export type ActivityReporter = (event: ActivityEvent) => void

export function safeToolDetail(toolName: string, args: unknown): string {
  if (!args || typeof args !== 'object') return `Calling ${toolName}`
  const values = Object.entries(args as Record<string, unknown>).map(([key, value]) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    return `${key}: ${(text ?? '').slice(0, 160)}`
  })
  return values.length ? values.join(' · ') : `Calling ${toolName}`
}
