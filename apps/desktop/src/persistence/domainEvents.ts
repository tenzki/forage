import {
  parseEventEnvelope,
  type EventEnvelope,
  type OutlineEventType,
} from '@forage/domain'
import type { OutlineShortcut, TrashEntry } from '../types/tree'

export interface DomainEventContext {
  outlineId: string
  actorId: string
  deviceId: string
  baseRevision: number
  nextEventId: () => string
  now?: () => string
}

type DomainMutation =
  | { type: 'trash'; operation: 'add' | 'restore' | 'purge'; entry: TrashEntry }
  | { type: 'shortcuts'; before: OutlineShortcut[]; after: OutlineShortcut[] }

export function shortcutId(shortcut: OutlineShortcut): string {
  if (shortcut.type === 'search') {
    return `search:${shortcut.scopeId ?? 'all'}:${shortcut.target}`
  }
  return `${shortcut.type}:${shortcut.target}`
}

function shortcutPayload(shortcut: OutlineShortcut): Record<string, unknown> {
  if (shortcut.type === 'node') {
    return { id: shortcutId(shortcut), kind: 'node', nodeId: shortcut.target }
  }
  if (shortcut.type === 'tag') {
    return { id: shortcutId(shortcut), kind: 'tag', tag: shortcut.target }
  }
  return {
    id: shortcutId(shortcut), kind: 'search', query: shortcut.target,
    label: shortcut.label, scopeId: shortcut.scopeId,
  }
}

function envelope(
  type: OutlineEventType,
  payload: Record<string, unknown>,
  context: DomainEventContext,
): EventEnvelope {
  return parseEventEnvelope({
    id: context.nextEventId(),
    outlineId: context.outlineId,
    actorId: context.actorId,
    deviceId: context.deviceId,
    type,
    eventVersion: 1,
    documentVersion: 1,
    schemaEpoch: 1,
    baseRevision: context.baseRevision,
    origin: 'desktop',
    occurredAt: (context.now ?? (() => new Date().toISOString()))(),
    payload,
  })
}

export function createDomainEvents(
  mutation: DomainMutation,
  context: DomainEventContext,
): EventEnvelope[] {
  if (mutation.type === 'trash') {
    if (mutation.operation === 'add') {
      return [envelope('trash.entry_added', { entry: mutation.entry }, context)]
    }
    return [envelope(
      mutation.operation === 'restore' ? 'trash.entry_restored' : 'trash.entry_purged',
      { entryId: mutation.entry.id },
      context,
    )]
  }

  const beforeById = new Map(mutation.before.map((shortcut) => [shortcutId(shortcut), shortcut]))
  const afterById = new Map(mutation.after.map((shortcut) => [shortcutId(shortcut), shortcut]))
  const events: EventEnvelope[] = []
  for (const id of beforeById.keys()) {
    if (!afterById.has(id)) events.push(envelope('shortcut.deleted', { shortcutId: id }, context))
  }
  for (const [id, shortcut] of afterById) {
    if (!beforeById.has(id)) events.push(envelope('shortcut.created', { shortcut: shortcutPayload(shortcut) }, context))
  }
  const beforeOrder = [...beforeById.keys()].filter((id) => afterById.has(id))
  const afterOrder = [...afterById.keys()]
  const projectionAfterAdds = [...beforeOrder, ...afterOrder.filter((id) => !beforeById.has(id))]
  if (afterOrder.length > 1 && afterOrder.some((id, index) => projectionAfterAdds[index] !== id)) {
    events.push(envelope('shortcuts.reordered', { shortcutIds: afterOrder }, context))
  }
  return events
}

export function createAssetReferenceEvents(
  source: Extract<EventEnvelope, { type: 'document.steps_applied' }>,
  nextEventId: () => string,
): EventEnvelope[] {
  const references = new Map<string, string>()
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit)
    if (!value || typeof value !== 'object') return
    const record = value as Record<string, unknown>
    if (typeof record.assetId === 'string' && typeof record.alt === 'string') {
      references.set(record.assetId, record.alt)
    }
    Object.values(record).forEach(visit)
  }
  visit(source.payload.steps)
  return [...references].map(([assetId, alt]) => parseEventEnvelope({
    ...source,
    id: nextEventId(),
    type: 'asset.reference_added',
    changeGroupId: undefined,
    payload: { assetId, alt },
  }))
}
