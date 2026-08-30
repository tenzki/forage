import type { Node as ProseMirrorNode } from '@tiptap/pm/model'

export const SYSTEM_ROLES = ['inbox', 'daily-notes', 'daily-note'] as const
export type SystemRole = typeof SYSTEM_ROLES[number]

export type JsonObject = Record<string, unknown>

type PmJson = {
  type: string
  attrs?: Record<string, unknown>
  content?: PmJson[]
  text?: string
  marks?: unknown[]
}

interface JsonLocation {
  node: PmJson
  list: PmJson
  index: number
  ancestorIds: string[]
  topLevel: boolean
}

export interface SystemNodeIssue {
  code:
    | 'missing_inbox'
    | 'missing_daily_notes'
    | 'duplicate_inbox'
    | 'duplicate_daily_notes'
    | 'nested_inbox'
    | 'nested_daily_notes'
    | 'orphaned_daily_note'
    | 'invalid_daily_date'
    | 'duplicate_daily_date'
    | 'unsupported_system_role'
    | 'stray_daily_date'
  nodeId?: string
}

export interface SystemNodeRepairResult {
  doc: JsonObject
  changed: boolean
  issues: SystemNodeIssue[]
}

export interface SystemNodeEntry {
  id: string
  role: SystemRole
  dailyDate: string | null
  pos: number
  node: ProseMirrorNode
  ancestorIds: string[]
}

const ROLE_SET = new Set<string>(SYSTEM_ROLES)

function nodeId(node: PmJson): string {
  return typeof node.attrs?.nodeId === 'string' ? node.attrs.nodeId : ''
}

export function isSystemRole(value: unknown): value is SystemRole {
  return typeof value === 'string' && ROLE_SET.has(value)
}

export function isCanonicalDailyDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day
}

function rootList(doc: PmJson): PmJson {
  const content = doc.content ?? []
  const firstIndex = content.findIndex((node) => node.type === 'bulletList')
  if (firstIndex >= 0) {
    const existing = content[firstIndex]
    const mergedItems = [...(existing.content ?? [])]
    doc.content = content.filter((node, index) => {
      if (index === firstIndex || node.type !== 'bulletList') return true
      mergedItems.push(...(node.content ?? []))
      return false
    })
    existing.content = mergedItems
    return existing
  }
  const created: PmJson = { type: 'bulletList', content: [] }
  doc.content = [created]
  return created
}

function childList(item: PmJson): PmJson {
  const existing = item.content?.find((node) => node.type === 'bulletList')
  if (existing) return existing
  const created: PmJson = { type: 'bulletList', content: [] }
  item.content = [...(item.content ?? []), created]
  return created
}

function collectLocations(doc: PmJson): JsonLocation[] {
  const locations: JsonLocation[] = []
  const visit = (node: PmJson, ancestors: string[], atRoot: boolean): void => {
    if (node.type === 'bulletList') {
      for (let index = 0; index < (node.content ?? []).length; index += 1) {
        const item = node.content![index]
        if (item.type !== 'listItem') continue
        locations.push({ node: item, list: node, index, ancestorIds: ancestors, topLevel: atRoot })
        const id = nodeId(item)
        for (const child of item.content ?? []) visit(child, id ? [...ancestors, id] : ancestors, false)
      }
      return
    }
    for (const child of node.content ?? []) visit(child, ancestors, atRoot)
  }
  visit(rootList(doc), [], true)
  return locations
}

function findLocation(doc: PmJson, id: string): JsonLocation | null {
  return collectLocations(doc).find((location) => nodeId(location.node) === id) ?? null
}

function roleOf(node: PmJson): SystemRole | null {
  return isSystemRole(node.attrs?.systemRole) ? node.attrs!.systemRole as SystemRole : null
}

function setRole(node: PmJson, role: SystemRole | null, dailyDate: string | null = null): void {
  node.attrs = { ...(node.attrs ?? {}), systemRole: role, dailyDate }
}

function systemItem(id: string, role: 'inbox' | 'daily-notes', title: string): PmJson {
  return {
    type: 'listItem',
    attrs: {
      nodeId: id,
      nodeType: 'user',
      collapsed: false,
      bulletKind: 'bullet',
      completed: false,
      systemRole: role,
      dailyDate: null,
    },
    content: [{ type: 'paragraph', content: [{ type: 'text', text: title }] }],
  }
}

function detach(doc: PmJson, id: string): PmJson | null {
  const location = findLocation(doc, id)
  if (!location) return null
  return location.list.content?.splice(location.index, 1)[0] ?? null
}

function moveToRoot(doc: PmJson, id: string): void {
  const item = detach(doc, id)
  if (item) rootList(doc).content!.push(item)
}

function normalizeMetadata(doc: PmJson, issues: SystemNodeIssue[]): void {
  for (const { node } of collectLocations(doc)) {
    const id = nodeId(node)
    const rawRole = node.attrs?.systemRole
    if (rawRole != null && !isSystemRole(rawRole)) {
      issues.push({ code: 'unsupported_system_role', nodeId: id || undefined })
      setRole(node, null)
      continue
    }
    const role = roleOf(node)
    const rawDate = node.attrs?.dailyDate
    if (role === 'daily-note') {
      if (!isCanonicalDailyDate(rawDate)) {
        issues.push({ code: 'invalid_daily_date', nodeId: id || undefined })
        setRole(node, null)
      } else {
        setRole(node, role, rawDate)
      }
    } else if (rawDate != null) {
      issues.push({ code: 'stray_daily_date', nodeId: id || undefined })
      setRole(node, role)
    } else {
      setRole(node, role)
    }
  }
}

function canonicalContainer(
  doc: PmJson,
  role: 'inbox' | 'daily-notes',
  nextId: () => string,
  issues: SystemNodeIssue[],
): PmJson {
  const matches = collectLocations(doc).filter((location) => roleOf(location.node) === role)
  if (!matches.length) {
    issues.push({ code: role === 'inbox' ? 'missing_inbox' : 'missing_daily_notes' })
    const item = systemItem(nextId(), role, role === 'inbox' ? 'Inbox' : 'Daily Notes')
    rootList(doc).content!.push(item)
    return item
  }
  const canonical = matches[0]
  for (const duplicate of matches.slice(1)) {
    setRole(duplicate.node, null)
    issues.push({
      code: role === 'inbox' ? 'duplicate_inbox' : 'duplicate_daily_notes',
      nodeId: nodeId(duplicate.node) || undefined,
    })
  }
  if (!canonical.topLevel) {
    issues.push({
      code: role === 'inbox' ? 'nested_inbox' : 'nested_daily_notes',
      nodeId: nodeId(canonical.node) || undefined,
    })
    moveToRoot(doc, nodeId(canonical.node))
  }
  return findLocation(doc, nodeId(canonical.node))?.node ?? canonical.node
}

function repairDailyNotes(doc: PmJson, dailyNotes: PmJson, issues: SystemNodeIssue[]): void {
  const dailyNotesId = nodeId(dailyNotes)
  const candidates = collectLocations(doc)
    .filter((location) => roleOf(location.node) === 'daily-note')
    .map((location) => nodeId(location.node))
  const seenDates = new Set<string>()
  for (const id of candidates) {
    const location = findLocation(doc, id)
    if (!location) continue
    const date = location.node.attrs?.dailyDate
    if (!isCanonicalDailyDate(date)) {
      setRole(location.node, null)
      issues.push({ code: 'invalid_daily_date', nodeId: id || undefined })
      continue
    }
    if (seenDates.has(date)) {
      setRole(location.node, null)
      issues.push({ code: 'duplicate_daily_date', nodeId: id || undefined })
      continue
    }
    seenDates.add(date)
    const directChild = location.ancestorIds.length === 1 && location.ancestorIds[0] === dailyNotesId
    if (!directChild) {
      const page = detach(doc, id)
      if (page) childList(dailyNotes).content!.push(page)
      issues.push({ code: 'orphaned_daily_note', nodeId: id || undefined })
    }
  }
}

/** Repair semantic system-node identity without matching titles or deleting content. */
export function repairSystemNodes(value: JsonObject, nextId: () => string): SystemNodeRepairResult {
  const before = JSON.stringify(value)
  const doc = structuredClone(value) as PmJson
  const issues: SystemNodeIssue[] = []
  rootList(doc)
  normalizeMetadata(doc, issues)
  canonicalContainer(doc, 'inbox', nextId, issues)
  const dailyNotes = canonicalContainer(doc, 'daily-notes', nextId, issues)
  repairDailyNotes(doc, dailyNotes, issues)
  const repaired = doc as JsonObject
  return { doc: repaired, changed: JSON.stringify(repaired) !== before, issues }
}

export function findSystemNode(doc: ProseMirrorNode, role: SystemRole): SystemNodeEntry | null {
  let found: SystemNodeEntry | null = null
  doc.descendants((node, pos) => {
    if (found || node.type.name !== 'listItem' || node.attrs.systemRole !== role) return
    const resolved = doc.resolve(pos)
    const ancestorIds: string[] = []
    for (let depth = 1; depth <= resolved.depth; depth += 1) {
      const ancestor = resolved.node(depth)
      if (ancestor.type.name === 'listItem' && ancestor.attrs.nodeId) ancestorIds.push(String(ancestor.attrs.nodeId))
    }
    found = {
      id: String(node.attrs.nodeId ?? ''),
      role,
      dailyDate: isCanonicalDailyDate(node.attrs.dailyDate) ? node.attrs.dailyDate : null,
      pos,
      node,
      ancestorIds,
    }
    return false
  })
  return found
}
