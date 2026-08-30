import { describe, expect, it } from 'vitest'
import { parseEventEnvelope } from '@forage/domain'
import { mergeAgentDocumentEvents } from './agentEventBatch'

function event(id: string, step: string, inverse: string) {
  return parseEventEnvelope({
    id, outlineId: 'outline', actorId: 'owner', deviceId: 'device',
    type: 'document.steps_applied', eventVersion: 1, documentVersion: 1, schemaEpoch: 1,
    baseRevision: 0, origin: 'desktop', occurredAt: `2026-08-30T00:00:0${id === 'a' ? 0 : 1}.000Z`,
    changeGroupId: 'agent-group',
    payload: { steps: [{ step }], inverseSteps: [{ step: inverse }], beforeHash: 'a'.repeat(64), afterHash: 'b'.repeat(64) },
  }) as Extract<ReturnType<typeof parseEventEnvelope>, { type: 'document.steps_applied' }>
}

describe('agent event batching', () => {
  it('keeps forward steps chronological and inverse steps in undo order', () => {
    const merged = mergeAgentDocumentEvents([event('a', 'one', 'undo-one'), event('b', 'two', 'undo-two')])
    expect(merged.payload.steps).toEqual([{ step: 'one' }, { step: 'two' }])
    expect(merged.payload.inverseSteps).toEqual([{ step: 'undo-two' }, { step: 'undo-one' }])
  })
})
