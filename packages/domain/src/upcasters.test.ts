import { describe, expect, it } from 'vitest'
import { EventUpcasterRegistry } from './upcasters'

describe('event upcasters', () => {
  it('upcasts retained payload versions one version at a time', () => {
    const registry = new EventUpcasterRegistry()
    registry.register('note.created', 0, (event) => ({
      ...event,
      eventVersion: 1,
      payload: {
        noteId: String(event.payload.id),
        parentId: String(event.payload.parent),
        text: String(event.payload.content),
      },
    }))

    const upgraded = registry.upcast({
      id: 'event-1',
      outlineId: 'outline-1',
      actorId: 'owner-1',
      deviceId: 'device-1',
      type: 'note.created',
      eventVersion: 0,
      documentVersion: 1,
      schemaEpoch: 1,
      baseRevision: 0,
      origin: 'migration',
      occurredAt: '2026-08-30T12:00:00.000Z',
      payload: { id: 'note-1', parent: 'inbox', content: 'captured' },
    }, 1)

    expect(upgraded.eventVersion).toBe(1)
    expect(upgraded.payload).toEqual({ noteId: 'note-1', parentId: 'inbox', text: 'captured' })
  })

  it('rejects unknown future versions instead of partially acknowledging them', () => {
    expect(() => new EventUpcasterRegistry().upcast({
      id: 'event-1',
      outlineId: 'outline-1',
      actorId: 'owner-1',
      deviceId: 'device-1',
      type: 'note.created',
      eventVersion: 2,
      documentVersion: 1,
      schemaEpoch: 1,
      baseRevision: 0,
      origin: 'server',
      occurredAt: '2026-08-30T12:00:00.000Z',
      payload: {},
    }, 1)).toThrow(/future event version/i)
  })
})
