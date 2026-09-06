import { useState } from 'react'
import { Check, ChevronDown, CircleAlert, CircleDot, Clock3, Eraser, LoaderCircle, Sparkles, Wrench, X } from 'lucide-react'

export type ActivityKind = 'skill' | 'command' | 'thinking' | 'tool' | 'output' | 'error'
export type ActivityStatus = 'running' | 'complete' | 'error' | 'cancelled'

export interface ActivityEntry {
  id: string
  kind: ActivityKind
  label: string
  detail?: string
  status: ActivityStatus
  timestamp: number
  durationMs?: number
  /** Outline bullet this event produced, if any. */
  nodeId?: string
}

export interface ActivityCall {
  id: string
  kind?: ActivityKind
  label: string
  detail?: string
  status: ActivityStatus
  timestamp: number
  durationMs?: number
  /** Bullet the skill was invoked from. */
  nodeId?: string
  events: ActivityEntry[]
}

function durationLabel(durationMs?: number): string | null {
  if (durationMs === undefined) return null
  if (durationMs < 1_000) return `${durationMs}ms`
  return `${(durationMs / 1_000).toFixed(1)}s`
}

function kindIcon(kind: ActivityKind) {
  if (kind === 'tool') return <Wrench aria-hidden="true" />
  if (kind === 'command') return <CircleDot aria-hidden="true" />
  if (kind === 'thinking') return <Sparkles aria-hidden="true" />
  if (kind === 'output') return <Check aria-hidden="true" />
  if (kind === 'error') return <CircleAlert aria-hidden="true" />
  return <Sparkles aria-hidden="true" />
}

function statusIcon(status: ActivityStatus) {
  if (status === 'running') return <LoaderCircle className="activity-status-spinner" aria-label="Running" />
  if (status === 'error') return <CircleAlert aria-label="Error" />
  if (status === 'cancelled') return <X aria-label="Cancelled" />
  return <Check aria-label="Complete" />
}

export function ActivitySidebar({
  calls,
  onClear,
  onOpenNode,
  collapsed = false,
}: {
  calls: ActivityCall[]
  onClear: () => void
  /** Reveal a bullet in the outline; `contextNodeId` is the branch it lives under. */
  onOpenNode?: (nodeId: string, contextNodeId?: string) => void
  collapsed?: boolean
}) {
  const [collapsedCalls, setCollapsedCalls] = useState<Set<string>>(new Set())
  const [expandedEvents, setExpandedEvents] = useState<Set<string>>(new Set())

  function toggleEvent(id: string): void {
    setExpandedEvents((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleCall(id: string): void {
    setCollapsedCalls((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <aside
      className={`activity-sidebar${collapsed ? ' is-collapsed' : ''}`}
      aria-label="Agent activity"
      hidden={collapsed}
    >
      <div className="activity-sidebar-header">
        {!collapsed && (
          <div>
            <h2>Activity</h2>
            <p>{calls.length ? `${calls.length} call${calls.length === 1 ? '' : 's'}` : 'Live agent trace'}</p>
          </div>
        )}
      </div>

      {!collapsed && (
        <>
          <div className="activity-sidebar-toolbar">
            <span><CircleDot aria-hidden="true" /> Observable events</span>
            <button type="button" aria-label="Clear activity" onClick={onClear} disabled={!calls.length}>
              <Eraser aria-hidden="true" /> Clear
            </button>
          </div>
          <div className="activity-list" aria-live="polite">
            {!calls.length && (
              <div className="activity-empty">
                <Clock3 aria-hidden="true" />
                <strong>No activity yet</strong>
                <span>Run a skill to see its work here.</span>
              </div>
            )}
            {[...calls].reverse().map((call) => {
              const duration = durationLabel(call.durationMs)
              const isCallCollapsed = collapsedCalls.has(call.id)
              return (
                <section key={call.id} className={`activity-call is-${call.status}`}>
                  <div className="activity-call-header">
                    <button
                      type="button"
                      className="activity-call-open"
                      aria-label={call.nodeId ? `Open outline bullet for ${call.label}` : call.label}
                      disabled={!call.nodeId || !onOpenNode}
                      onClick={() => call.nodeId && onOpenNode?.(call.nodeId)}
                    >
                      <span className={`activity-kind-icon is-${call.kind ?? call.events[0]?.kind ?? 'skill'}`}>{kindIcon(call.kind ?? call.events[0]?.kind ?? 'skill')}</span>
                      <span className="activity-entry-main">
                        <strong>{call.label}</strong>
                        <small>{new Date(call.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</small>
                      </span>
                      {duration && <span className="activity-duration">{duration}</span>}
                      <span className="activity-status-icon">{statusIcon(call.status)}</span>
                    </button>
                    <button
                      type="button"
                      className="activity-call-toggle"
                      aria-expanded={!isCallCollapsed}
                      aria-label={`${isCallCollapsed ? 'Expand' : 'Collapse'} execution for ${call.label}`}
                      onClick={() => toggleCall(call.id)}
                    >
                      <ChevronDown className={`activity-detail-chevron${isCallCollapsed ? '' : ' is-expanded'}`} aria-hidden="true" />
                    </button>
                  </div>
                  {!isCallCollapsed && call.events.length > 0 && (
                    <ol className="activity-timeline" aria-label={`Execution timeline for ${call.label}`}>
                      {call.events.map((entry) => {
                        const isExpanded = expandedEvents.has(entry.id)
                        return (
                          <li key={entry.id} className={`activity-timeline-event is-${entry.status}`}>
                            <span className={`activity-kind-icon is-${entry.kind}`}>{kindIcon(entry.kind)}</span>
                            <div className="activity-timeline-content">
                              <button
                                type="button"
                                className={`activity-timeline-label${entry.nodeId ? ' is-navigable' : ''}`}
                                aria-label={entry.nodeId ? `Open outline result for ${entry.label}` : undefined}
                                onClick={() => {
                                  if (entry.nodeId && onOpenNode) onOpenNode(entry.nodeId, call.nodeId)
                                  else if (entry.detail) toggleEvent(entry.id)
                                }}
                                aria-expanded={entry.detail && !entry.nodeId ? isExpanded : undefined}
                              >
                                <strong>{entry.label}</strong>
                                <span className="activity-status-icon">{statusIcon(entry.status)}</span>
                              </button>
                              {entry.detail && (
                                <button type="button" className={`activity-entry-detail${isExpanded ? ' is-expanded' : ''}`} onClick={() => toggleEvent(entry.id)}>
                                  {isExpanded ? <pre>{entry.detail}</pre> : <span>{entry.detail}</span>}
                                  <ChevronDown className="activity-detail-chevron" aria-hidden="true" />
                                </button>
                              )}
                            </div>
                          </li>
                        )
                      })}
                    </ol>
                  )}
                </section>
              )
            })}
          </div>
        </>
      )}
    </aside>
  )
}

export { durationLabel }
