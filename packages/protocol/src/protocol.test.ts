import { describe, expect, it } from 'vitest'
import {
  notesCreateRequestSchema,
  pushEventsRequestSchema,
  serverStatusSchema,
} from './index'

describe('shared HTTP protocol schemas', () => {
  it('accepts only bounded plain-text note creation input', () => {
    expect(notesCreateRequestSchema.parse({
      text: 'Capture this thought',
      parentId: 'inbox',
      source: { application: 'Raycast' },
      clientCreatedAt: '2026-08-30T12:00:00.000Z',
    }).text).toBe('Capture this thought')
    expect(() => notesCreateRequestSchema.parse({ text: '<p>raw</p>', html: '<p>raw</p>' })).toThrow()
    expect(() => notesCreateRequestSchema.parse({ text: '' })).toThrow()
  })

  it('bounds synchronization batches and advertises independent compatibility versions', () => {
    expect(() => pushEventsRequestSchema.parse({
      baseRevision: 0,
      events: Array.from({ length: 101 }, (_, index) => ({ id: String(index) })),
    })).toThrow(/too_big|100/i)

    const status = serverStatusSchema.parse({
      instanceId: 'instance-1',
      apiVersions: [1],
      eventVersions: { 'note.created': [1] },
      agentOriginVersions: [1],
      minimumAgentClientVersion: '0.2.0',
      documentSchemaVersion: 1,
      minimumClientVersion: '0.1.0',
    })
    expect(status.apiVersions).toEqual([1])
  })
})
