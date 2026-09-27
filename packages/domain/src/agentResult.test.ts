import { describe, expect, it } from 'vitest'
import { Transform } from '@tiptap/pm/transform'
import { applySerializedSteps, captureStepBatch, createOutlineSchema, queryCanonicalOutline } from '../../document/src'
import { createInitialOutlineState, parseEventEnvelope, replayOutlineEvents, type EventEnvelope, type OutlineState } from './index'

function item(nodeId: string, text: string, children: unknown[] = []) {
  return {
    type: 'listItem',
    attrs: { nodeId, nodeType: 'user', collapsed: false, bulletKind: 'bullet', completed: false },
    content: [
      { type: 'paragraph', content: [{ type: 'text', text }] },
      ...(children.length ? [{ type: 'bulletList', content: children }] : []),
    ],
  }
}

function result(
  runId: string,
  revision: number,
  nodes: Array<{ nodeId: string; text: string }>,
  replaces?: { runId: string; rootNoteIds: string[] },
): EventEnvelope {
  return parseEventEnvelope({
    id: `event-${runId}`, outlineId: 'outline-1', actorId: 'owner-1', deviceId: 'agent-instance',
    type: 'agent.result_committed', eventVersion: replaces ? 2 : 1, documentVersion: 1, schemaEpoch: 1,
    baseRevision: revision - 1, revision, origin: 'agent', occurredAt: '2026-09-26T12:00:00.000Z',
    changeGroupId: `run_${runId}`,
    agentProvenance: { runId, skillId: 'research', sourceNodeId: 'call', sourceUrls: [] },
    payload: {
      runId, targetNodeId: 'call', nodes: nodes.map((node) => ({ type: 'text', ...node })), sources: [],
      ...(replaces ? { replaces } : {}),
    },
  })
}

function texts(state: OutlineState): string[] {
  return queryCanonicalOutline(state).nodes().map((node) => node.text)
}

const initial = createInitialOutlineState({
  type: 'doc',
  content: [{ type: 'bulletList', content: [item('call', '/research tides'), item('other', 'Other')] }],
})

const version1 = result('run-1', 1, [{ nodeId: 'v1-a', text: 'Version 1 A' }, { nodeId: 'v1-b', text: 'Version 1 B' }])

describe('agent result replay', () => {
  it('replays a version 1 result as an insert under the invocation', () => {
    expect(texts(replayOutlineEvents(initial, [version1]))).toEqual(['/research tides', 'Version 1 A', 'Version 1 B', 'Other'])
  })

  it('replaces the previous version in one event, keeping roots the user moved away', () => {
    const afterFirst = replayOutlineEvents(initial, [version1])
    const replacing = result('run-2', 2, [{ nodeId: 'v2-a', text: 'Version 2' }], { runId: 'run-1', rootNoteIds: ['v1-a', 'v1-b'] })
    expect(texts(replayOutlineEvents(afterFirst, [replacing]))).toEqual(['/research tides', 'Version 2', 'Other'])

    // The user moved one generated root out of the call and deleted the other.
    const moved = createInitialOutlineState({
      type: 'doc',
      content: [{ type: 'bulletList', content: [item('call', '/research tides'), item('v1-a', 'Version 1 A')] }],
    })
    expect(texts(replayOutlineEvents(moved, [replacing]))).toEqual(['/research tides', 'Version 2', 'Version 1 A'])
  })

  it('keeps version 1 events valid and requires version 2 exactly when a result replaces', () => {
    const replacing = result('run-2', 2, [{ nodeId: 'v2-a', text: 'Version 2' }], { runId: 'run-1', rootNoteIds: ['v1-a'] })
    expect(() => parseEventEnvelope({ ...replacing, eventVersion: 1 })).toThrow(/version 2/i)
    expect(() => parseEventEnvelope({ ...version1, eventVersion: 2 })).toThrow(/version 2/i)
  })

  it('undoes a synchronized replacing revision back to the previous version as one unit', () => {
    const schema = createOutlineSchema()
    const afterFirst = replayOutlineEvents(initial, [version1])
    const replaced = replayOutlineEvents(afterFirst, [
      result('run-2', 2, [{ nodeId: 'v2-a', text: 'Version 2' }], { runId: 'run-1', rootNoteIds: ['v1-a', 'v1-b'] }),
    ])
    // A device applies the pulled projection as one whole-document replacement and
    // records its inverse as the undo step, as the desktop editor does.
    const before = schema.nodeFromJSON(afterFirst.doc)
    const after = schema.nodeFromJSON(replaced.doc)
    const transform = new Transform(before).replaceWith(0, before.content.size, after.content)
    const batch = captureStepBatch(before, transform.steps)

    expect(applySerializedSteps(before, batch.steps).eq(after)).toBe(true)
    expect(applySerializedSteps(after, batch.inverseSteps).eq(before)).toBe(true)
  })
})
