import { describe, expect, it } from 'vitest'
import { createAssetReferenceEvents, createDomainEvents, type DomainEventContext } from './domainEvents'
import { parseEventEnvelope } from '@forage/domain'
import type { OutlineShortcut, TrashEntry } from '../types/tree'

const context: DomainEventContext = {
  outlineId: 'outline-1', actorId: 'owner-1', deviceId: 'device-1', baseRevision: 0,
  nextEventId: () => crypto.randomUUID(),
  now: () => '2026-08-30T12:00:00.000Z',
}

const entry: TrashEntry = {
  id: 'trash-1', deletedAt: '2026-08-30T12:00:00.000Z', originalParentId: null,
  originalIndex: 0,
  node: { type: 'listItem', attrs: { nodeId: 'note-1' }, content: [{ type: 'paragraph' }] },
}

describe('domain mutation events', () => {
  it('represents trash, restore, and purge as explicit immutable events', () => {
    expect(createDomainEvents({ type: 'trash', operation: 'add', entry }, context)[0].type)
      .toBe('trash.entry_added')
    expect(createDomainEvents({ type: 'trash', operation: 'restore', entry }, context)[0].type)
      .toBe('trash.entry_restored')
    expect(createDomainEvents({ type: 'trash', operation: 'purge', entry }, context)[0].type)
      .toBe('trash.entry_purged')
  })

  it('emits stable shortcut identities for additions and one ordering event for reordering', () => {
    const node: OutlineShortcut = { type: 'node', target: 'note-1' }
    const tag: OutlineShortcut = { type: 'tag', target: 'research' }
    const added = createDomainEvents({ type: 'shortcuts', before: [], after: [node] }, context)
    const reordered = createDomainEvents({ type: 'shortcuts', before: [node, tag], after: [tag, node] }, context)

    expect(added).toHaveLength(1)
    expect(added[0]).toMatchObject({
      type: 'shortcut.created',
      payload: { shortcut: { id: 'node:note-1', kind: 'node', nodeId: 'note-1' } },
    })
    expect(reordered).toHaveLength(1)
    expect(reordered[0]).toMatchObject({
      type: 'shortcuts.reordered',
      payload: { shortcutIds: ['tag:research', 'node:note-1'] },
    })
  })

  it('emits an asset reference event when a document step inserts an asset node', () => {
    const documentEvent = parseEventEnvelope({
      id: 'document-event', outlineId: 'outline-1', actorId: 'owner-1', deviceId: 'device-1',
      type: 'document.steps_applied', eventVersion: 1, documentVersion: 1, schemaEpoch: 1,
      baseRevision: 0, origin: 'desktop', occurredAt: '2026-08-30T12:00:00.000Z',
      payload: { steps: [{ slice: { content: [{ attrs: { assetId: 'a'.repeat(64), alt: 'Chart' } }] } }],
        inverseSteps: [{}], beforeHash: 'a'.repeat(64), afterHash: 'b'.repeat(64) },
    }) as Extract<ReturnType<typeof parseEventEnvelope>, { type: 'document.steps_applied' }>
    expect(createAssetReferenceEvents(documentEvent, () => 'asset-event')).toMatchObject([
      { id: 'asset-event', type: 'asset.reference_added', payload: { assetId: 'a'.repeat(64), alt: 'Chart' } },
    ])
  })
})
