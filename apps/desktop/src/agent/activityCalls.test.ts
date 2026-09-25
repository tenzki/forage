import { describe, expect, it } from 'vitest'
import { applyActivityEvent, callsFromHistory, fromRuntimeEvent } from './activityCalls'
import type { ActivityCall } from '../components/Agent/ActivitySidebar'
import type { LocalAgentRunHistory } from '../persistence/eventStore'

const snapshot = {
  version: 1 as const,
  runId: 'run-1',
  executionMode: 'local' as const,
  outlineId: 'outline-1',
  source: { nodeId: 'bullet-1', text: 'research tauri' },
  target: { parentId: 'bullet-1' },
  baseRevision: 0,
  configurationRevision: 0,
  credentialRef: 'local-openai',
  agent: {
    id: 'researcher', name: 'Researcher', description: 'Researches things',
    systemPrompt: 'Research', modelId: '', toolIds: ['web_search'],
  },
  skill: {
    id: 'research', label: 'research', description: 'Research a topic',
    systemPrompt: 'Research it', agentId: 'researcher', requiredToolIds: [],
  },
  effectiveToolIds: ['web_search'],
  prompt: 'research tauri',
  context: [],
}

describe('activity calls', () => {
  it('groups every event of one run under a single call', () => {
    const events = [
      { id: 'run-1', phase: 'start' as const, kind: 'skill' as const, label: 'Run /research tauri', nodeId: 'bullet-1' },
      fromRuntimeEvent({ id: 'thinking-1', sequence: 1, phase: 'start', kind: 'thinking', label: 'Thinking' }, 'run-1'),
      fromRuntimeEvent({ id: 'tool-1', sequence: 2, phase: 'start', kind: 'tool', label: 'web_search', detail: 'query: tauri' }, 'run-1'),
      fromRuntimeEvent({ id: 'tool-1', sequence: 3, phase: 'complete', kind: 'tool', label: 'web_search', status: 'success' }, 'run-1'),
      { id: 'run-1', phase: 'complete' as const, kind: 'skill' as const, label: 'Run /research tauri', nodeId: 'bullet-1', durationMs: 4200 },
    ]

    const calls = events.reduce<ActivityCall[]>((current, event) => applyActivityEvent(current, event, 10), [])

    expect(calls).toHaveLength(1)
    expect(calls[0].id).toBe('run-1')
    expect(calls[0].status).toBe('complete')
    expect(calls[0].durationMs).toBe(4200)
    expect(calls[0].nodeId).toBe('bullet-1')
    expect(calls[0].events.map((entry) => entry.id)).toEqual(['thinking-1', 'tool-1'])
    expect(calls[0].events[1].status).toBe('complete')
    expect(calls[0].events[1].detail).toBe('query: tauri')
  })

  it('keeps separate runs in separate calls', () => {
    const first = applyActivityEvent([], { id: 'run-1', phase: 'start', kind: 'skill', label: 'Run /research a' }, 1)
    const second = applyActivityEvent(first, { id: 'run-2', phase: 'start', kind: 'skill', label: 'Run /research b' }, 2)

    expect(second.map((call) => call.id)).toEqual(['run-1', 'run-2'])
  })

  it('groups runtime tool-call IDs beneath the agent run instead of at the top level', () => {
    const parent = applyActivityEvent([], {
      id: 'run-1', phase: 'start', kind: 'skill', label: 'Run /research',
    }, 1)
    const withTool = applyActivityEvent(parent, fromRuntimeEvent({
      id: 'tool-call-1', callId: 'provider-tool-call-1', sequence: 1,
      phase: 'start', kind: 'tool', label: 'web_fetch', status: 'running',
    }, 'run-1'), 2)

    expect(withTool).toHaveLength(1)
    expect(withTool[0]).toMatchObject({ id: 'run-1', label: 'Run /research' })
    expect(withTool[0].events).toEqual([
      expect.objectContaining({ id: 'tool-call-1', label: 'web_fetch' }),
    ])
  })

  it('rebuilds calls from persisted runs, oldest first, with navigable results', () => {
    const history: LocalAgentRunHistory[] = [
      {
        run: {
          id: 'run-1', outlineId: 'outline-1', snapshot, status: 'completed', attemptCount: 1,
          resultIdentity: 'result:run-1', result: { version: 1, nodes: [{ type: 'text', text: 'Done' }], sources: [] },
          retryOfRunId: null, cancelRequestedAt: null, errorCode: null,
          createdAt: '2026-09-06T10:00:00.000Z', updatedAt: '2026-09-06T10:00:03.000Z',
        },
        activity: [
          {
            runId: 'run-1', sequence: 1, createdAt: '2026-09-06T10:00:01.000Z',
            event: { id: 'thinking-1', sequence: 1, phase: 'complete', kind: 'thinking', label: 'Thinking', status: 'success' },
          },
          {
            runId: 'run-1', sequence: 2, createdAt: '2026-09-06T10:00:03.000Z',
            event: { id: 'result-run-1', sequence: 2, phase: 'complete', kind: 'output', label: 'Open result', nodeId: 'bullet-9', status: 'success' },
          },
        ],
      },
    ]

    const calls = callsFromHistory(history)

    expect(calls).toHaveLength(1)
    expect(calls[0].label).toBe('Run /research research tauri')
    expect(calls[0].status).toBe('complete')
    expect(calls[0].durationMs).toBe(3_000)
    expect(calls[0].nodeId).toBe('bullet-1')
    expect(calls[0].events.map((entry) => entry.id)).toEqual(['thinking-1', 'result-run-1'])
    expect(calls[0].events[1].nodeId).toBe('bullet-9')
  })

  it('reports an unfinished persisted run as still running', () => {
    const [call] = callsFromHistory([
      {
        run: {
          id: 'run-2', outlineId: 'outline-1', snapshot: { ...snapshot, runId: 'run-2' }, status: 'interrupted',
          attemptCount: 1, resultIdentity: null, result: null, retryOfRunId: null, cancelRequestedAt: null,
          errorCode: 'desktop_restarted', createdAt: '2026-09-06T10:00:00.000Z', updatedAt: '2026-09-06T10:00:02.000Z',
        },
        activity: [],
      },
    ])

    expect(call.status).toBe('cancelled')
  })

  it('rehydrates a retained generic result as complete but awaiting placement', () => {
    const extensionSnapshot = {
      version: 2 as const,
      execution: 'extension' as const,
      runId: 'extension-run', executionMode: 'local' as const, outlineId: 'outline-1',
      source: { nodeId: 'removed-invocation', text: '' }, target: { parentId: 'removed-invocation' },
      baseRevision: 0, configurationRevision: 3,
      authority: { type: 'local-extension-executor' as const, executor: { extensionId: 'dev.example.notes', executorId: 'label' } },
      localExecutorSnapshot: {
        version: 1 as const, catalogRevision: 'a'.repeat(64), configurationRevision: 11,
        source: { installationId: 'removed', extensionId: 'dev.example.notes', sourceRevision: 'one', entryDigest: 'b'.repeat(64), executorId: 'label' },
      },
      skill: {
        id: 'label', execution: 'extension' as const, label: 'label', description: 'Label',
        executor: { extensionId: 'dev.example.notes', executorId: 'label' }, configuration: {},
      },
      context: {
        prompt: '', invocation: { id: 'removed-invocation', text: '/label', documentOrder: 1 },
        roots: [{ id: 'candidate', text: 'Candidate', documentOrder: 0 }],
        provenance: { ancestorPathIds: [], explicitLinkedRootIds: [] },
      },
      plan: {
        selectedNodeIds: ['candidate'], requestedReferenceIds: ['candidate'], admittedReferenceIds: ['candidate'],
        annotations: [], data: {},
      },
    }
    const [call] = callsFromHistory([{
      run: {
        id: 'extension-run', outlineId: 'outline-1', snapshot: extensionSnapshot,
        status: 'completed_unplaced', attemptCount: 1, resultIdentity: 'result:extension-run',
        result: { version: 2, nodes: [{ type: 'text', segments: [{ type: 'text', text: 'Saved' }] }], sources: [] },
        retryOfRunId: null, cancelRequestedAt: null, errorCode: null,
        createdAt: '2026-09-20T10:00:00.000Z', updatedAt: '2026-09-20T10:00:01.000Z',
      },
      activity: [],
    }])

    expect(call).toMatchObject({
      id: 'extension-run', label: 'Run /label', status: 'complete', placementPending: true,
    })
  })

  it('rehydrates conversation turns with their reply, thread, and inline answer', () => {
    const run = (id: string, runSnapshot: object, result: LocalAgentRunHistory['run']['result'], createdAt: string) => ({
      run: {
        id, outlineId: 'outline-1', snapshot: runSnapshot as LocalAgentRunHistory['run']['snapshot'], status: 'completed' as const,
        attemptCount: 1, resultIdentity: `result:${id}`, result, retryOfRunId: null, cancelRequestedAt: null,
        errorCode: null, createdAt, updatedAt: createdAt,
      },
      activity: [],
    })
    const calls = callsFromHistory([
      run('run-1', { ...snapshot, thread: { callId: 'run-1', turn: 1 } },
        { version: 1, nodes: [{ type: 'text', text: 'Finding' }], sources: [] }, '2026-09-25T10:00:00.000Z'),
      run('run-2', {
        ...snapshot, runId: 'run-2', prompt: 'Which source said that?', thread: { callId: 'run-1', turn: 2 },
        invocationOutline: ['- [agent] Finding'],
      }, { version: 1, type: 'answer', text: 'The Tauri docs.' }, '2026-09-25T10:01:00.000Z'),
    ])

    expect(calls[0]).toMatchObject({ label: 'Run /research research tauri', thread: { callId: 'run-1', turn: 1 } })
    expect(calls[0].answer).toBeUndefined()
    expect(calls[1]).toMatchObject({
      label: 'Run /research research tauri', detail: 'research tauri', note: 'Which source said that?',
      thread: { callId: 'run-1', turn: 2 }, answer: 'The Tauri docs.',
    })
  })

  it('streams a reply answer into its call and clears it when the turn ends without one', () => {
    let calls: ActivityCall[] = []
    calls = applyActivityEvent(calls, { id: 'run-2', phase: 'start', kind: 'skill', label: 'Run /research x', thread: { callId: 'run-1', turn: 2 } }, 1)
    calls = applyActivityEvent(calls, { id: 'run-2', phase: 'start', kind: 'skill', label: 'Run /research x', answer: 'Partial' }, 2)
    expect(calls[0]).toMatchObject({ thread: { callId: 'run-1', turn: 2 }, answer: 'Partial', status: 'running' })
    calls = applyActivityEvent(calls, { id: 'run-2', phase: 'cancelled', kind: 'skill', label: 'Run /research x', answer: '' }, 3)
    expect(calls[0].answer).toBeUndefined()
    expect(calls[0].thread).toEqual({ callId: 'run-1', turn: 2 })
  })
})
