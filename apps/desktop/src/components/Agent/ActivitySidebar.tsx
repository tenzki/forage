// Agent activity panel (Screens 07A/07B in docs/desktop.pen).
//
// The list shows one row per skill call — a skill run on a bullet, plus its
// steered follow-ups as later versions. Opening a row shows the call's thread:
// the searches it ran, the pages it read, one write entry per version and the
// user's steering notes, with a composer that starts the next version.

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  ArrowLeft,
  ArrowUp,
  Ban,
  BookOpen,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleDot,
  Clock3,
  Eraser,
  Globe,
  ImageIcon,
  Info,
  ListPlus,
  LoaderCircle,
  LocateFixed,
  Search,
  Sparkles,
  Square,
  User,
  Wrench,
} from 'lucide-react'
import { replacedOutput } from '../../agent/skillRuns'
import {
  groupSkillCalls,
  iterationResultNodeId,
  skillCallThread,
  toolArgument,
  type SkillCallGroup,
  type ThreadItem,
} from '../../agent/skillCalls'
import { Button } from '../ui/Button'
import { EmptyState } from '../ui/EmptyState'
import { IconButton } from '../ui/IconButton'
import { StatusPill, type StatusTone } from '../ui/StatusPill'

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
  placementPending?: boolean
  /** The user's steering note that started this iteration, if it was one. */
  note?: string
  events: ActivityEntry[]
}

/** What the panel may show about an outline bullet. */
export interface ActivityNodeInfo {
  title: string
  /** Bullets in the node's subtree, itself included. */
  bulletCount: number
}

function durationLabel(durationMs?: number): string | null {
  if (durationMs === undefined) return null
  if (durationMs < 1_000) return `${durationMs}ms`
  return `${(durationMs / 1_000).toFixed(1)}s`
}

function clockTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
}

function dayLabel(timestamp: number, now = Date.now()): string {
  const day = new Date(timestamp)
  const today = new Date(now)
  const startOf = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const difference = Math.round((startOf(today) - startOf(day)) / 86_400_000)
  if (difference <= 0) return 'Today'
  if (difference === 1) return 'Yesterday'
  return day.toLocaleDateString([], { month: 'long', day: 'numeric' })
}

function kindIcon(group: SkillCallGroup) {
  if (/^\/image\b/u.test(group.title)) return <ImageIcon aria-hidden="true" />
  if (group.kind === 'command') return <CircleDot aria-hidden="true" />
  return <Sparkles aria-hidden="true" />
}

const STATUS_LABEL: Record<ActivityStatus, string> = {
  running: 'Running',
  complete: 'Done',
  error: 'Failed',
  cancelled: 'Cancelled',
}

const STATUS_TONE: Record<ActivityStatus, StatusTone> = {
  running: 'running',
  complete: 'success',
  error: 'danger',
  cancelled: 'muted',
}

function CallStatusPill({ status }: { status: ActivityStatus }) {
  return (
    <StatusPill tone={STATUS_TONE[status]} icon={status === 'cancelled' ? <Ban /> : true}>
      {STATUS_LABEL[status]}
    </StatusPill>
  )
}

function versionSummary(group: SkillCallGroup): string | null {
  if (group.kind !== 'skill') return null
  const count = group.iterations.length
  const produced = group.iterations.some(({ call }) => call.status === 'complete' || call.status === 'running')
  if (!produced) return 'No output'
  return `v${count}  ·  ${count} ${count === 1 ? 'iteration' : 'iterations'}`
}

function activitySummary(groups: SkillCallGroup[]): string {
  if (!groups.length) return 'Live agent trace'
  const running = groups.filter((group) => group.status === 'running').length
  const skills = groups.filter((group) => group.kind === 'skill').length
  const total = skills === groups.length
    ? `${groups.length} skill ${groups.length === 1 ? 'call' : 'calls'}`
    : `${groups.length} ${groups.length === 1 ? 'call' : 'calls'}`
  return running ? `${total} · ${running} running` : total
}

function CallRow({ group, context, onOpen, onPlaceResult }: {
  group: SkillCallGroup
  context: string | null
  onOpen: () => void
  onPlaceResult?: (runId: string) => void
}) {
  const summary = versionSummary(group)
  return (
    <div className={`activity-call-row is-${group.status}`}>
      <button type="button" className="activity-call-row-open" aria-label={`Open ${group.title}`} onClick={onOpen}>
        <span className="activity-kind-badge">{kindIcon(group)}</span>
        <span className="activity-call-row-main">
          <strong
            className={group.status === 'running' ? 't-shimmer' : undefined}
            data-text={group.status === 'running' ? group.title : undefined}
          >
            {group.title}
          </strong>
          <span className="activity-call-row-context">
            {context ? `On “${context}”  ·  ` : ''}{clockTime(group.timestamp)}
          </span>
          <span className="activity-call-row-meta">
            <CallStatusPill status={group.status} />
            {summary && <span className="activity-version">{summary}</span>}
          </span>
        </span>
        <ChevronRight className="activity-call-row-chevron" aria-hidden="true" />
      </button>
      {group.latest.placementPending && (
        <Button size="sm" className="activity-place-result" onClick={() => onPlaceResult?.(group.latest.id)} disabled={!onPlaceResult}>
          Place here
        </Button>
      )}
    </div>
  )
}

function ToolHead({ icon, name, count, duration, expanded, onToggle }: {
  icon: ReactNode
  name: string
  count?: string
  duration: string | null
  expanded?: boolean
  onToggle?: () => void
}) {
  const content = (
    <>
      <span className="activity-tool-icon">{icon}</span>
      <span className="activity-tool-name">{name}</span>
      <span className="activity-tool-spacer" />
      {count && <span className="activity-tool-count">{count}</span>}
      {duration && <span className="activity-tool-count">{duration}</span>}
      {onToggle && <ChevronDown className={expanded ? 'activity-tool-chevron is-open' : 'activity-tool-chevron'} aria-hidden="true" />}
    </>
  )
  if (!onToggle) return <div className="activity-tool-head">{content}</div>
  return (
    <button type="button" className="activity-tool-head" aria-expanded={expanded} aria-label={`${expanded ? 'Hide' : 'Show'} ${name} calls`} onClick={onToggle}>
      {content}
    </button>
  )
}

function pageLabel(url: string): { title: string; domain: string } {
  try {
    const parsed = new URL(url)
    const segments = parsed.pathname.split('/').filter(Boolean)
    const last = segments[segments.length - 1]?.replace(/[-_]+/gu, ' ').replace(/\.\w+$/u, '')
    return { title: last ? decodeURIComponent(last) : parsed.hostname, domain: parsed.hostname.replace(/^www\./u, '') }
  } catch {
    return { title: url, domain: '' }
  }
}

function entryState(status: ActivityStatus) {
  if (status === 'running') return <LoaderCircle className="activity-row-state is-running" aria-label="Running" />
  if (status === 'error') return <span className="activity-row-state is-error">failed</span>
  return null
}

function ToolGroup({ item }: { item: Extract<ThreadItem, { type: 'tools' }> }) {
  const [expanded, setExpanded] = useState(true)
  const total = item.entries.reduce((sum, entry) => sum + (entry.durationMs ?? 0), 0)
  const duration = total ? durationLabel(total) : null
  const count = item.entries.length
  if (item.family === 'search') {
    return (
      <div className="activity-tool">
        <ToolHead icon={<Search />} name={item.tool} count={`${count} ${count === 1 ? 'query' : 'queries'}`} duration={duration} expanded={expanded} onToggle={() => setExpanded((open) => !open)} />
        {expanded && (
          <ul className="activity-tool-list">
            {item.entries.map((entry) => (
              <li key={entry.id} className="activity-query-row">
                <Search aria-hidden="true" />
                <span>{toolArgument(entry.detail) || entry.label}</span>
                {entryState(entry.status)}
              </li>
            ))}
          </ul>
        )}
      </div>
    )
  }
  if (item.family === 'read') {
    return (
      <div className="activity-tool">
        <ToolHead icon={<BookOpen />} name={item.tool} count={`${count} ${count === 1 ? 'page' : 'pages'}`} duration={duration} expanded={expanded} onToggle={() => setExpanded((open) => !open)} />
        {expanded && (
          <ul className="activity-tool-list">
            {item.entries.map((entry) => {
              const url = toolArgument(entry.detail)
              const page = pageLabel(url)
              return (
                <li key={entry.id} className="activity-page-row" title={url}>
                  <span className="activity-page-favicon"><Globe aria-hidden="true" /></span>
                  <span className="activity-page-title">{page.title}</span>
                  {page.domain && <span className="activity-page-domain">{page.domain}</span>}
                  {entryState(entry.status)}
                </li>
              )
            })}
          </ul>
        )}
      </div>
    )
  }
  return (
    <div className="activity-tool">
      <ToolHead icon={<Wrench />} name={item.tool} duration={duration} />
      <div className="activity-tool-io">
        {item.entries.map((entry) => (
          <p key={entry.id}>
            <span>{entry.detail ? entry.detail.split('\n')[0] : 'No arguments'}</span>
            {entry.status === 'error' && <span className="activity-tool-output is-error">→ {entry.detail?.split('\n').slice(1).join(' ') || 'failed'}</span>}
            {entry.status === 'running' && <span className="activity-tool-output">→ running…</span>}
          </p>
        ))}
      </div>
    </div>
  )
}

function OutputEntry({ item, group, describeNode, onOpenNode }: {
  item: Extract<ThreadItem, { type: 'output' }>
  group: SkillCallGroup
  describeNode?: (nodeId: string) => ActivityNodeInfo | null
  onOpenNode?: (nodeId: string, contextNodeId?: string) => void
}) {
  const [showSnapshot, setShowSnapshot] = useState(false)
  const target = group.nodeId ? describeNode?.(group.nodeId)?.title : undefined
  const result = item.resultNodeId ? describeNode?.(item.resultNodeId) : null
  const snapshot = item.superseded ? replacedOutput(item.call.id) : undefined
  const writing = item.call.status === 'running'
  const openable = Boolean(item.resultNodeId && result && onOpenNode)
  return (
    <div className={`activity-tool is-bullets${writing ? ' is-writing' : ''}`}>
      <div className="activity-tool-head">
        <span className="activity-tool-icon">{writing ? <LoaderCircle className="is-spinning" /> : <ListPlus />}</span>
        <span className="activity-tool-name">write_bullets</span>
        <span className="activity-tool-spacer" />
        <span className="activity-version-badge">v{item.version}</span>
      </div>
      <button
        type="button"
        className="activity-tool-io is-row"
        disabled={!openable && !snapshot}
        aria-label={openable ? `Open version ${item.version} in the outline` : snapshot ? `Show version ${item.version}` : undefined}
        onClick={() => {
          if (openable && item.resultNodeId) onOpenNode?.(item.resultNodeId, group.nodeId)
          else if (snapshot) setShowSnapshot((open) => !open)
        }}
      >
        <span className="activity-output-target">{target || 'Outline'}</span>
        {writing && <span className="activity-output-added">writing…</span>}
        {!writing && result && <span className="activity-output-added">+{result.bulletCount}</span>}
        {!writing && item.superseded && <span className="activity-output-replaced">replaced by v{item.version + 1}</span>}
        {!writing && !result && !item.superseded && <span className="activity-output-replaced">no longer in outline</span>}
      </button>
      {showSnapshot && snapshot && (
        <div className="activity-snapshot">
          <ul>{snapshot.map((line, index) => <li key={index}>{line.replace(/^\s*- /u, '')}</li>)}</ul>
          <p>Snapshot · no longer in outline</p>
        </div>
      )}
    </div>
  )
}

function ThreadEvent({ entry }: { entry: Extract<ThreadItem, { type: 'event' }>['entry'] }) {
  return (
    <div className={`activity-agent-note is-${entry.status}`}>
      <span className="activity-avatar is-agent">{entry.status === 'error' ? <CircleAlert /> : <Sparkles />}</span>
      <div>
        <span className="activity-note-meta">{entry.kind === 'error' || entry.status === 'error' ? 'Error' : 'Agent'}  ·  {clockTime(entry.timestamp)}</span>
        <p>{entry.label}</p>
        {entry.detail && <p className="activity-note-detail">{entry.detail}</p>}
      </div>
    </div>
  )
}

function Composer({ group, running, onSteer }: {
  group: SkillCallGroup
  running: boolean
  onSteer: (note: string) => void
}) {
  const [note, setNote] = useState('')
  const send = () => {
    const trimmed = note.trim()
    if (!trimmed || running) return
    onSteer(trimmed)
    setNote('')
  }
  return (
    <div className="activity-composer">
      <textarea
        aria-label={`Steer ${group.title}`}
        placeholder={running ? `Wait for v${group.iterations.length} to finish, or stop it.` : 'Steer this call…'}
        value={note}
        disabled={running}
        rows={2}
        onChange={(event) => setNote(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault()
            send()
          }
        }}
      />
      <div className="activity-composer-bar">
        <span className="activity-composer-hint">Replaces v{group.iterations.length} with v{group.iterations.length + 1}</span>
        <span className="activity-composer-key">⌘ Enter</span>
        <button type="button" className="activity-composer-send" aria-label="Send steering note" disabled={!note.trim() || running} onClick={send}>
          <ArrowUp aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}

function CallDetail({ group, position, total, describeNode, onBack, onOpenNode, onCancel, canCancel, canSteer, onSteer, onPlaceResult }: {
  group: SkillCallGroup
  position: number
  total: number
  describeNode?: (nodeId: string) => ActivityNodeInfo | null
  onBack: () => void
  onOpenNode?: (nodeId: string, contextNodeId?: string) => void
  onCancel?: (runId: string) => void
  canCancel?: (runId: string) => boolean
  canSteer?: (group: SkillCallGroup) => boolean
  onSteer?: (group: SkillCallGroup, note: string) => void
  onPlaceResult?: (runId: string) => void
}) {
  const thread = useMemo(() => skillCallThread(group), [group])
  const summary = versionSummary(group)
  const running = group.status === 'running'
  // The newest write still in the outline; without one, the invocation bullet.
  const resultNodeId = [...group.iterations].reverse()
    .map(({ call }) => iterationResultNodeId(call))
    .find((nodeId) => nodeId && (!describeNode || describeNode(nodeId)))
  const goTo = resultNodeId ?? group.nodeId
  const stoppable = running && onCancel && canCancel?.(group.latest.id)
  const steerable = Boolean(onSteer && canSteer?.(group))

  return (
    <div className="activity-detail">
      <div className="activity-detail-nav">
        <button type="button" className="activity-back" onClick={onBack}>
          <ArrowLeft aria-hidden="true" /> All activity
        </button>
        <span className="activity-detail-position">{position} of {total}</span>
      </div>
      <div className="activity-detail-header">
        <span className="activity-kind-badge is-large">{kindIcon(group)}</span>
        <div className="activity-detail-title">
          <h3>{group.title}</h3>
          <span className="activity-call-row-meta">
            <CallStatusPill status={group.status} />
            {summary && <span className="activity-version">{summary}</span>}
            {group.latest.durationMs !== undefined && <span className="activity-version is-muted">{durationLabel(group.latest.durationMs)}</span>}
          </span>
        </div>
      </div>
      <div className="activity-detail-actions">
        {goTo && onOpenNode && (
          <Button
            variant="agent"
            icon={<LocateFixed aria-hidden="true" />}
            onClick={() => onOpenNode(goTo, resultNodeId ? group.nodeId : undefined)}
          >
            {resultNodeId ? 'Go to bullets' : 'Go to bullet'}
          </Button>
        )}
        {group.latest.placementPending && (
          <Button size="sm" onClick={() => onPlaceResult?.(group.latest.id)} disabled={!onPlaceResult}>Place here</Button>
        )}
        <span className="activity-tool-spacer" />
        {stoppable && (
          <IconButton label="Stop" onClick={() => onCancel(group.latest.id)}>
            <Square size={14} />
          </IconButton>
        )}
      </div>

      <div className="activity-thread" aria-label={`Steps for ${group.title}`}>
        {thread.map((item, index) => {
          if (item.type === 'note') {
            return (
              <div key={index} className="activity-comment">
                <span className="activity-avatar"><User /></span>
                <div>
                  <span className="activity-note-meta">You  ·  {clockTime(item.timestamp)}</span>
                  <p>{item.text}</p>
                </div>
              </div>
            )
          }
          if (item.type === 'tools') return <ToolGroup key={index} item={item} />
          if (item.type === 'output') return <OutputEntry key={index} item={item} group={group} describeNode={describeNode} onOpenNode={onOpenNode} />
          return <ThreadEvent key={index} entry={item.entry} />
        })}
        {!thread.length && (
          <p className="activity-thread-empty">{running ? 'Working…' : 'No steps were recorded for this call.'}</p>
        )}
        {group.status === 'error' && group.latest.detail && group.latest.detail !== group.prompt && (
          <div className="activity-agent-note is-error">
            <span className="activity-avatar is-agent"><CircleAlert /></span>
            <div>
              <span className="activity-note-meta">Error</span>
              <p>{group.latest.detail}</p>
            </div>
          </div>
        )}
      </div>

      {steerable && onSteer && <Composer group={group} running={running} onSteer={(note) => onSteer(group, note)} />}
    </div>
  )
}

export function ActivitySidebar({
  calls,
  onClear,
  onOpenNode,
  onPlaceResult,
  onCancel,
  canCancel,
  describeNode,
  canSteer,
  onSteer,
  collapsed = false,
}: {
  calls: ActivityCall[]
  onClear: () => void
  /** Reveal a bullet in the outline; `contextNodeId` is the branch it lives under. */
  onOpenNode?: (nodeId: string, contextNodeId?: string) => void
  /** Place a durably retained completed result under the current bullet. */
  onPlaceResult?: (runId: string) => void
  /** Stop a run that is still executing. */
  onCancel?: (runId: string) => void
  canCancel?: (runId: string) => boolean
  /** Title and size of an outline bullet, for call context and write summaries. */
  describeNode?: (nodeId: string) => ActivityNodeInfo | null
  /** Whether a skill call can take a steering note. */
  canSteer?: (group: SkillCallGroup) => boolean
  /** Start the next version of a skill call from the user's note. */
  onSteer?: (group: SkillCallGroup, note: string) => void
  collapsed?: boolean
}) {
  const groups = useMemo(() => groupSkillCalls(calls), [calls])
  const [openId, setOpenId] = useState<string | null>(null)
  const openIndex = openId ? groups.findIndex((group) => group.id === openId) : -1
  const openGroup = openIndex === -1 ? null : groups[openIndex]!

  // A cleared or pruned call closes its detail view.
  useEffect(() => {
    if (openId && openIndex === -1) setOpenId(null)
  }, [openId, openIndex])

  const days: Array<{ label: string; groups: SkillCallGroup[] }> = []
  for (const group of groups) {
    const label = dayLabel(group.timestamp)
    const day = days[days.length - 1]
    if (day?.label === label) day.groups.push(group)
    else days.push({ label, groups: [group] })
  }

  return (
    <aside
      className={`activity-sidebar${collapsed ? ' is-collapsed' : ''}`}
      aria-label="Agent activity"
      aria-hidden={collapsed || undefined}
      data-open={String(!collapsed)}
      hidden={collapsed}
    >
      {!collapsed && openGroup && (
        <CallDetail
          group={openGroup}
          position={openIndex + 1}
          total={groups.length}
          describeNode={describeNode}
          onBack={() => setOpenId(null)}
          onOpenNode={onOpenNode}
          onCancel={onCancel}
          canCancel={canCancel}
          canSteer={canSteer}
          onSteer={onSteer}
          onPlaceResult={onPlaceResult}
        />
      )}
      {!collapsed && !openGroup && (
        <>
          <div className="activity-sidebar-header">
            <div>
              <h2>Activity</h2>
              <p>{activitySummary(groups)}</p>
            </div>
            <button type="button" className="activity-clear" aria-label="Clear activity" onClick={onClear} disabled={!calls.length}>
              <Eraser aria-hidden="true" /> Clear
            </button>
          </div>
          <div className="activity-sidebar-toolbar">
            <span><CircleDot aria-hidden="true" /> Observable events</span>
          </div>
          <div className="activity-list" aria-live="polite">
            {!groups.length && (
              <EmptyState icon={<Clock3 />} title="No activity yet" description="Run a skill to see its work here." />
            )}
            {days.map((day) => (
              <section key={day.label} className="activity-day" aria-label={day.label}>
                <h3 className="activity-day-label">{day.label}</h3>
                {day.groups.map((group) => (
                  <CallRow
                    key={group.id}
                    group={group}
                    context={group.nodeId ? describeNode?.(group.nodeId)?.title ?? null : null}
                    onOpen={() => setOpenId(group.id)}
                    onPlaceResult={onPlaceResult}
                  />
                ))}
              </section>
            ))}
          </div>
          {groups.some((group) => group.kind === 'skill') && (
            <p className="activity-footer-hint"><Info aria-hidden="true" /> Open a call to see its steps and steer it.</p>
          )}
        </>
      )}
    </aside>
  )
}

export { durationLabel }
