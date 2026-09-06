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
})
