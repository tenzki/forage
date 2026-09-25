// Skill calls for the activity panel (Screens 07A/07B in docs/desktop.pen).
//
// Each run is one ActivityCall. A *skill call* groups the runs of one skill on
// one bullet: the first run is v1 and every steered follow-up is the next
// version. Grouping is derived from the run list rather than stored, so it also
// holds for history rebuilt after a restart.

import type { ActivityCall, ActivityEntry, ActivityStatus } from '../components/Agent/ActivitySidebar'

export interface SkillIteration {
  call: ActivityCall
  /** 1-based version number within the skill call. */
  version: number
}

export interface SkillCallGroup {
  /** The first run's id; stable while iterations are added. */
  id: string
  kind: 'skill' | 'command' | 'other'
  /** `/skill prompt`, without the `Run ` prefix. */
  title: string
  /** Skill label without the slash, when this is a skill run. */
  skillLabel?: string
  /** The prompt of the first iteration. */
  prompt: string
  /** The invocation bullet. */
  nodeId?: string
  iterations: SkillIteration[]
  latest: ActivityCall
  status: ActivityStatus
  /** When the latest iteration started. */
  timestamp: number
}

const RUN_LABEL = /^Run \/(\S+)(?:\s+([\s\S]*))?$/u

function parseRunLabel(label: string): { skillLabel: string; prompt: string } | null {
  const match = RUN_LABEL.exec(label)
  return match ? { skillLabel: match[1]!, prompt: (match[2] ?? '').trim() } : null
}

/** Group runs into skill calls, newest call first. */
export function groupSkillCalls(calls: ActivityCall[]): SkillCallGroup[] {
  const groups: SkillCallGroup[] = []
  const byKey = new Map<string, SkillCallGroup>()
  const ordered = [...calls].sort((left, right) => left.timestamp - right.timestamp)
  for (const call of ordered) {
    const run = call.kind === 'skill' || call.kind === undefined ? parseRunLabel(call.label) : null
    const key = run && call.nodeId ? `${call.nodeId}::${call.label}` : null
    const existing = key ? byKey.get(key) : undefined
    if (existing) {
      existing.iterations.push({ call, version: existing.iterations.length + 1 })
      existing.latest = call
      existing.status = call.status
      existing.timestamp = call.timestamp
      continue
    }
    const group: SkillCallGroup = {
      id: call.id,
      kind: run ? 'skill' : call.kind === 'command' ? 'command' : 'other',
      title: run ? `/${run.skillLabel}${run.prompt ? ` ${run.prompt}` : ''}` : call.label,
      ...(run ? { skillLabel: run.skillLabel } : {}),
      prompt: call.detail ?? run?.prompt ?? '',
      ...(call.nodeId ? { nodeId: call.nodeId } : {}),
      iterations: [{ call, version: 1 }],
      latest: call,
      status: call.status,
      timestamp: call.timestamp,
    }
    groups.push(group)
    if (key) byKey.set(key, group)
  }
  return groups.reverse()
}

/** The bullet an iteration wrote, if its output was recorded. */
export function iterationResultNodeId(call: ActivityCall): string | undefined {
  return [...call.events].reverse().find((entry) => entry.kind === 'output' && entry.nodeId)?.nodeId
}

export type ThreadItem =
  | { type: 'note'; text: string; timestamp: number }
  | { type: 'tools'; tool: string; family: 'search' | 'read' | 'other'; entries: ActivityEntry[] }
  | { type: 'output'; version: number; call: ActivityCall; resultNodeId?: string; superseded: boolean }
  | { type: 'event'; entry: ActivityEntry }

const SEARCH_TOOLS = new Set(['web_search', 'search_outline', 'outline_search'])
const READ_TOOLS = new Set(['web_fetch', 'web_read', 'x_read', 'youtube_transcript'])

function toolFamily(tool: string): 'search' | 'read' | 'other' {
  if (SEARCH_TOOLS.has(tool)) return 'search'
  if (READ_TOOLS.has(tool)) return 'read'
  return 'other'
}

/**
 * The thread shown inside a skill call: each iteration's steering note, its
 * tool calls grouped by consecutive tool, and one write entry per version.
 */
export function skillCallThread(group: SkillCallGroup): ThreadItem[] {
  const items: ThreadItem[] = []
  const lastVersion = group.iterations.length
  for (const { call, version } of group.iterations) {
    if (call.note) items.push({ type: 'note', text: call.note, timestamp: call.timestamp })
    let current: Extract<ThreadItem, { type: 'tools' }> | null = null
    for (const entry of call.events) {
      if (entry.kind === 'tool') {
        if (current && current.tool === entry.label) {
          current.entries.push(entry)
        } else {
          current = { type: 'tools', tool: entry.label, family: toolFamily(entry.label), entries: [entry] }
          items.push(current)
        }
        continue
      }
      current = null
      // Progress chatter and the write itself are summarised elsewhere.
      if (entry.kind === 'thinking' || entry.kind === 'output') continue
      items.push({ type: 'event', entry })
    }
    if (group.kind === 'skill' && call.status !== 'error' && call.status !== 'cancelled') {
      const resultNodeId = iterationResultNodeId(call)
      items.push({ type: 'output', version, call, ...(resultNodeId ? { resultNodeId } : {}), superseded: version < lastVersion })
    }
  }
  return items
}

/** The argument value a tool call was made with (`query: …` → `…`). */
export function toolArgument(detail: string | undefined): string {
  if (!detail) return ''
  const firstLine = detail.split('\n')[0] ?? ''
  const match = /^(?:query|url|prompt):\s*(.*)$/u.exec(firstLine)
  return (match ? match[1]! : firstLine).trim()
}
