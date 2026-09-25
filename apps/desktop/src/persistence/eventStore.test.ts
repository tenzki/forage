import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { NativeEventRepository } from './eventStore'

describe('native event repository', () => {
  beforeEach(() => invoke.mockReset())

  it('appends validated envelopes immediately through the narrow native command', async () => {
    invoke.mockResolvedValueOnce(4)
    const repository = new NativeEventRepository()
    const sequence = await repository.append({
      id: 'event-1', outlineId: 'outline-1', actorId: 'owner-1', deviceId: 'device-1',
      type: 'shortcut.created', eventVersion: 1, documentVersion: 1, schemaEpoch: 1,
      baseRevision: 0, origin: 'desktop', occurredAt: '2026-08-30T12:00:00.000Z',
      payload: { shortcut: { id: 'shortcut-1', kind: 'node', nodeId: 'root' } },
    })

    expect(sequence).toBe(4)
    expect(invoke).toHaveBeenCalledWith('event_store_append', {
      event: expect.objectContaining({ id: 'event-1', status: 'pending' }),
    })
  })

  it('loads a verified checkpoint and ordered later events for replay', async () => {
    invoke
      .mockResolvedValueOnce({
        id: 'checkpoint-1', outlineId: 'outline-1', documentVersion: 1, schemaEpoch: 1,
        localSequence: 3, serverRevision: 2, stateJson: '{"doc":{"type":"doc"},"trash":[],"shortcuts":[],"schemaEpoch":1}',
        integrityHash: 'a'.repeat(64), createdAt: '2026-08-30T12:00:00.000Z',
      })
      .mockResolvedValueOnce([{ localSequence: 4, serverRevision: 3, status: 'accepted', envelope: {
        id: 'event-4', outlineId: 'outline-1', actorId: 'owner-1', deviceId: 'device-1',
        type: 'shortcut.deleted', eventVersion: 1, documentVersion: 1, schemaEpoch: 1,
        baseRevision: 2, origin: 'desktop', occurredAt: '2026-08-30T12:00:00.000Z',
        payload: { shortcutId: 'shortcut-1' },
      } }])

    const loaded = await new NativeEventRepository().loadReplayInput('outline-1')

    expect(loaded?.checkpoint.localSequence).toBe(3)
    expect(loaded?.latestLocalSequence).toBe(4)
    expect(loaded?.events[0].type).toBe('shortcut.deleted')
    expect(loaded?.events[0].revision).toBe(3)
  })

  it('uses typed narrow commands for the durable local agent lifecycle', async () => {
    const repository = new NativeEventRepository()
    const run = {
      id: 'run-1', outlineId: 'outline-1', snapshot: {
        version: 1 as const,
        runId: 'run-1', executionMode: 'local' as const, outlineId: 'outline-1',
        source: { nodeId: 'source-1', text: 'Research this.' }, target: { parentId: 'source-1' },
        baseRevision: 0, configurationRevision: 1, credentialRef: 'local-openai',
        agent: {
          id: 'agent-1', name: 'Agent', description: 'Research agent', systemPrompt: 'Research.',
          modelId: 'gpt-5', toolIds: [],
        },
        skill: {
          id: 'research', label: 'research', description: 'Research', systemPrompt: 'Summarize.',
          agentId: 'agent-1', requiredToolIds: [],
        },
        effectiveToolIds: [], prompt: 'Research this.', context: [],
      }, status: 'queued' as const,
      attemptCount: 0, resultIdentity: null, result: null, retryOfRunId: null,
      cancelRequestedAt: null, errorCode: null,
      createdAt: '2026-08-31T10:00:00.000Z', updatedAt: '2026-08-31T10:00:00.000Z',
    }
    invoke
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce([{
        runId: 'run-1', sequence: 1,
        event: { id: 'activity-1', sequence: 1, phase: 'start', kind: 'thinking', label: 'Thinking' },
        createdAt: '2026-08-31T10:00:01.000Z',
      }])
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(2)

    await repository.admitAgentRun(run)
    await repository.beginAgentAttempt('run-1', '2026-08-31T10:00:01.000Z')
    await repository.appendAgentActivity('run-1', {
      id: 'activity-1', sequence: 1, phase: 'start', kind: 'thinking', label: 'Thinking',
    }, '2026-08-31T10:00:01.000Z')
    expect((await repository.agentActivityAfter('run-1', 0))[0]?.event.kind).toBe('thinking')
    await repository.cancelAgentRun('run-1', '2026-08-31T10:00:02.000Z')
    await repository.settleAgentRun('run-1', 'cancelled', null, null, null, '2026-08-31T10:00:02.000Z')
    await repository.placeAgentRunResult('run-placed', '2026-08-31T10:00:02.000Z')
    await repository.retryAgentRun('run-1', { ...run, id: 'run-2', retryOfRunId: 'run-1' })
    expect(await repository.interruptUnfinishedAgentRuns('2026-08-31T10:00:03.000Z')).toBe(2)

    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      'agent_run_admit', 'agent_run_begin_attempt', 'agent_run_append_activity',
      'agent_run_activity_after', 'agent_run_cancel', 'agent_run_settle',
      'agent_run_place_result', 'agent_run_retry', 'agent_run_interrupt_unfinished',
    ])
  })

  it('loads mixed legacy, threaded, and answered run history', async () => {
    const snapshot = {
      version: 1 as const, runId: 'run-legacy', executionMode: 'local' as const, outlineId: 'outline-1',
      source: { nodeId: 'source-1' }, target: { parentId: 'source-1' },
      baseRevision: 0, configurationRevision: 1, credentialRef: 'local-openai',
      agent: {
        id: 'agent-1', name: 'Agent', description: 'Research agent', systemPrompt: 'Research.',
        modelId: 'gpt-5', toolIds: [],
      },
      skill: {
        id: 'research', label: 'research', description: 'Research', systemPrompt: 'Summarize.',
        agentId: 'agent-1', requiredToolIds: [],
      },
      effectiveToolIds: [], prompt: 'Research this.', context: [],
    }
    const outline = { version: 1, nodes: [{ type: 'text', text: 'Finding' }], sources: [] }
    const answer = { version: 1, type: 'answer', text: 'Because the source is primary.' }
    const run = (id: string, runSnapshot: object, result: object | null) => ({
      run: {
        id, outlineId: 'outline-1', snapshot: runSnapshot, status: 'completed', attemptCount: 1,
        resultIdentity: `result:${id}`, result, retryOfRunId: null, cancelRequestedAt: null, errorCode: null,
        createdAt: '2026-09-25T10:00:00.000Z', updatedAt: '2026-09-25T10:00:01.000Z',
      },
      activity: [],
    })
    invoke.mockResolvedValueOnce([
      run('run-legacy', snapshot, outline),
      run('run-1', { ...snapshot, runId: 'run-1', thread: { callId: 'run-1', turn: 1 } }, outline),
      run('run-2', { ...snapshot, runId: 'run-2', prompt: 'Why?', thread: { callId: 'run-1', turn: 2 } }, answer),
    ])

    const history = await new NativeEventRepository().recentAgentRuns('outline-1')

    expect(history.map(({ run: loaded }) => loaded.snapshot.version === 1 ? loaded.snapshot.thread : null)).toEqual([
      undefined, { callId: 'run-1', turn: 1 }, { callId: 'run-1', turn: 2 },
    ])
    expect(history.map(({ run: loaded }) => loaded.result)).toEqual([outline, outline, answer])
  })

  it('rejects an inline answer stored on a run without a conversation turn', async () => {
    invoke.mockResolvedValueOnce({
      id: 'run-1', outlineId: 'outline-1', status: 'completed', attemptCount: 1,
      resultIdentity: 'result:run-1', retryOfRunId: null, cancelRequestedAt: null, errorCode: null,
      createdAt: '2026-09-25T10:00:00.000Z', updatedAt: '2026-09-25T10:00:01.000Z',
      result: { version: 1, type: 'answer', text: 'Answer.' },
      snapshot: {
        version: 1, runId: 'run-1', executionMode: 'local', outlineId: 'outline-1',
        source: { nodeId: 'source-1' }, target: { parentId: 'source-1' },
        baseRevision: 0, configurationRevision: 1, credentialRef: 'local-openai',
        agent: {
          id: 'agent-1', name: 'Agent', description: 'Research agent', systemPrompt: 'Research.',
          modelId: 'gpt-5', toolIds: [],
        },
        skill: {
          id: 'research', label: 'research', description: 'Research', systemPrompt: 'Summarize.',
          agentId: 'agent-1', requiredToolIds: [],
        },
        effectiveToolIds: [], prompt: 'Research this.', context: [],
      },
    })

    await expect(new NativeEventRepository().agentRun('run-1')).rejects.toThrow(/conversation turns/i)
  })
})
