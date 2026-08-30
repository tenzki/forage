import { describe, expect, it } from 'vitest'
import { createOutlineSchema } from '../../document/src'
import { buildSystemNodeRepairEvent } from './systemNodeMigration'
import { createInitialOutlineState, reduceOutlineEvent } from './reducer'

const legacyDoc = {
  type: 'doc',
  content: [{ type: 'bulletList', content: [{
    type: 'listItem',
    attrs: { nodeId: 'legacy', nodeType: 'user', collapsed: false, bulletKind: 'bullet', completed: false },
    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Legacy note' }] }],
  }] }],
}

describe('system-node event migration', () => {
  it('builds one migration-origin step event whose replay exactly produces the repaired document', async () => {
    const state = createInitialOutlineState(legacyDoc)
    const ids = ['inbox', 'daily']
    const migration = await buildSystemNodeRepairEvent(state, {
      outlineId: 'outline', actorId: 'owner', deviceId: 'device', baseRevision: 4,
      nextEventId: () => 'migration-event', nextNodeId: () => ids.shift()!,
      now: () => '2026-08-30T12:00:00.000Z',
    })

    expect(migration?.event).toMatchObject({
      id: 'migration-event', origin: 'migration', type: 'document.steps_applied', baseRevision: 4,
    })
    expect(migration?.event.payload.steps).toHaveLength(1)
    const replayed = reduceOutlineEvent(state, migration!.event)
    expect(replayed.doc).toEqual(migration?.state.doc)
    expect(createOutlineSchema().nodeFromJSON(replayed.doc).textContent).toContain('Legacy note')
  })

  it('repairs a legacy outline whose last root has nested children', async () => {
    const nestedLegacyDoc = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [{
            type: 'listItem',
            attrs: {
              nodeId: 'existing-inbox', nodeType: 'user', collapsed: false,
              bulletKind: 'bullet', completed: false, systemRole: 'inbox',
            },
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Inbox' }] }],
          }],
        },
        {
          type: 'bulletList',
          content: [{
            type: 'listItem',
            attrs: { nodeId: 'person', nodeType: 'user', collapsed: false, bulletKind: 'bullet', completed: false },
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'Nikola B' }] },
              {
                type: 'bulletList',
                content: [{
                  type: 'listItem',
                  attrs: { nodeId: 'dated-child', nodeType: 'user', collapsed: false, bulletKind: 'bullet', completed: false },
                  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'August 14, 2026' }] }],
                }],
              },
            ],
          }],
        },
      ],
    }
    const state = createInitialOutlineState(nestedLegacyDoc)
    const ids = ['daily']

    const migration = await buildSystemNodeRepairEvent(state, {
      outlineId: 'outline', actorId: 'owner', deviceId: 'device', baseRevision: 4,
      nextEventId: () => 'migration-event', nextNodeId: () => ids.shift()!,
      now: () => '2026-08-30T12:00:00.000Z',
    })

    const replayed = reduceOutlineEvent(state, migration!.event)
    expect(replayed.doc).toEqual(migration?.state.doc)
    const replayedDocument = createOutlineSchema().nodeFromJSON(replayed.doc)
    expect(replayedDocument.childCount).toBe(1)
    expect(replayedDocument.firstChild?.childCount).toBe(3)
    expect(replayedDocument.textContent).toContain('August 14, 2026')
  })

  it('returns null without allocating ids when invariants already hold', async () => {
    const state = createInitialOutlineState({
      type: 'doc', content: [{ type: 'bulletList', content: [
        { ...legacyDoc.content[0].content[0], attrs: { ...legacyDoc.content[0].content[0].attrs, systemRole: 'inbox' } },
        { ...legacyDoc.content[0].content[0], attrs: { ...legacyDoc.content[0].content[0].attrs, nodeId: 'daily', systemRole: 'daily-notes' } },
      ] }],
    })
    const result = await buildSystemNodeRepairEvent(state, {
      outlineId: 'outline', actorId: 'owner', deviceId: 'device', baseRevision: 0,
      nextEventId: () => { throw new Error('must not allocate event') },
      nextNodeId: () => { throw new Error('must not allocate node') },
    })

    expect(result).toBeNull()
  })
})
