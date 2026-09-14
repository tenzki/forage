import { describe, expect, it, vi } from 'vitest'
import type { ServerAgentTransport } from './serverExecutor'
import { ServerRunManager, type RememberedServerRun, type ServerRunMemory } from './serverRunManager'

describe('server run manager', () => {
  it('owns concurrent observations independently and persists cursors', async () => {
    let stored: RememberedServerRun[] = []
    const memory: ServerRunMemory = { load: async () => stored, save: async (runs) => { stored = structuredClone(runs) } }
    const transport = {
      invoke: vi.fn(async (intent) => ({ runId: intent.invocationId, status: 'queued' as const, admittedAt: '2026-09-13T10:00:00.000Z' })),
      activity: vi.fn(async (runId: string) => ({ events: [{ id: `event-${runId}`, sequence: 1, phase: 'complete' as const, kind: 'output' as const, label: 'Done' }], nextCursor: null, status: 'completed' as const })),
      run: vi.fn(async (runId: string) => ({ id: runId, outlineId: 'outline', trigger: 'manual' as const, status: 'completed' as const, skillId: 'skill', policyId: null, configurationRevision: 1, attemptCount: 1, admittedAt: '2026-09-13T10:00:00.000Z', updatedAt: '2026-09-13T10:00:01.000Z', retryOfRunId: null, error: null, result: null, placementError: null })),
      cancel: vi.fn(async () => undefined), retry: vi.fn(), runs: vi.fn(),
    } as ServerAgentTransport
    const manager = new ServerRunManager(transport, memory, { pollMs: 0, delay: async () => undefined })
    const activity = vi.fn()
    const first = await manager.invoke({ version: 2, invocationId: 'one', sourceNodeId: 'node', skillId: 'skill', prompt: 'One', acknowledgedOutlineRevision: 1 }, activity)
    const second = await manager.invoke({ version: 2, invocationId: 'two', sourceNodeId: 'node', skillId: 'skill', prompt: 'Two', acknowledgedOutlineRevision: 1 }, activity)
    await Promise.all([first.completion, second.completion])
    expect(stored.map((run) => run.runId).sort()).toEqual(['one', 'two'])
    expect(stored.every((run) => run.status === 'completed' && run.lastSequence === 1)).toBe(true)
    expect(activity).toHaveBeenCalledTimes(4)
    expect(activity.mock.calls.filter(([event]) => event.id === event.callId)).toHaveLength(2)
  })

  it('keeps a remembered run alive across a transient disconnect', async () => {
    let stored: RememberedServerRun[] = [{
      runId: 'remote', invocationId: 'invocation', lastSequence: 0, status: 'running', updatedAt: '2026-09-13T10:00:00.000Z',
    }]
    let offline = true
    const memory: ServerRunMemory = { load: async () => stored, save: async (runs) => { stored = structuredClone(runs) } }
    const transport = {
      activity: vi.fn(async () => {
        if (offline) { offline = false; throw new Error('offline') }
        return { events: [], nextCursor: null, status: 'completed' as const }
      }),
      run: vi.fn(async () => ({
        id: 'remote', outlineId: 'outline', trigger: 'manual' as const, status: 'completed' as const,
        skillId: 'skill', policyId: null, configurationRevision: 1, attemptCount: 1,
        admittedAt: '2026-09-13T10:00:00.000Z', updatedAt: '2026-09-13T10:00:01.000Z',
        retryOfRunId: null, error: null, result: null, placementError: null,
      })),
      invoke: vi.fn(), cancel: vi.fn(), retry: vi.fn(),
    } as unknown as ServerAgentTransport
    const manager = new ServerRunManager(transport, memory, { pollMs: 0, delay: async () => undefined })
    await manager.restore()
    for (let index = 0; index < 20 && stored[0]?.status !== 'completed'; index += 1) await Promise.resolve()
    expect(stored[0]?.status).toBe('completed')
    expect(transport.activity).toHaveBeenCalledTimes(2)
  })

  it('adopts an inbox automation run the server started and reports its activity', async () => {
    let stored: RememberedServerRun[] = []
    const memory: ServerRunMemory = { load: async () => stored, save: async (runs) => { stored = structuredClone(runs) } }
    const detail = (id: string, trigger: 'manual' | 'inbox_automation', status: 'running' | 'completed') => ({
      id, outlineId: 'outline', trigger, status, skillId: 'research-inbox', policyId: trigger === 'manual' ? null : 'github',
      configurationRevision: 4, attemptCount: 1, admittedAt: '2026-09-13T10:00:00.000Z', updatedAt: '2026-09-13T10:00:01.000Z',
      retryOfRunId: null, error: null, result: null, placementError: null,
    })
    let inboxStatus: 'running' | 'completed' = 'running'
    const transport = {
      run: vi.fn(async (runId: string) => detail(runId, runId === 'inbox' ? 'inbox_automation' : 'manual', runId === 'inbox' ? inboxStatus : 'running')),
      activity: vi.fn(async () => {
        inboxStatus = 'completed'
        return { events: [{ id: 'fetch', sequence: 1, phase: 'complete' as const, kind: 'tool' as const, label: 'Read github.com' }], nextCursor: null, status: 'running' as const }
      }),
      runs: vi.fn(), invoke: vi.fn(), cancel: vi.fn(), retry: vi.fn(),
    } as unknown as ServerAgentTransport
    const manager = new ServerRunManager(transport, memory, { pollMs: 0, delay: async () => undefined, skillLabel: () => 'research' })
    const activity = vi.fn()
    await manager.restore(activity)

    await manager.adopt('manual-elsewhere')
    await manager.adopt('inbox')
    const settled = () => activity.mock.calls.some(([event]) => event.id === 'inbox' && event.status === 'success')
    for (let index = 0; index < 20 && !settled(); index += 1) await Promise.resolve()

    expect(stored).toEqual([expect.objectContaining({ runId: 'inbox', status: 'completed' })])
    expect(activity).toHaveBeenCalledWith(expect.objectContaining({ id: 'fetch', label: 'Read github.com' }), 'inbox')
    expect(activity).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'inbox', label: 'Inbox /research', status: 'success' }), 'inbox')
  })

  it('adopts inbox automation runs still active on the server after reconnecting', async () => {
    let stored: RememberedServerRun[] = []
    const memory: ServerRunMemory = { load: async () => stored, save: async (runs) => { stored = structuredClone(runs) } }
    const summary = (id: string, trigger: 'manual' | 'inbox_automation', status: 'running' | 'completed') => ({
      id, outlineId: 'outline', trigger, status, skillId: 'research-inbox', policyId: null, configurationRevision: 4,
      attemptCount: 1, admittedAt: '2026-09-13T10:00:00.000Z', updatedAt: '2026-09-13T10:00:01.000Z', retryOfRunId: null,
    })
    const transport = {
      runs: vi.fn(async () => ({ runs: [summary('active', 'inbox_automation', 'running'), summary('done', 'inbox_automation', 'completed'), summary('mine', 'manual', 'running')], nextCursor: null })),
      activity: vi.fn(() => new Promise<never>(() => undefined)),
      run: vi.fn(), invoke: vi.fn(), cancel: vi.fn(), retry: vi.fn(),
    } as unknown as ServerAgentTransport
    const manager = new ServerRunManager(transport, memory, { skillLabel: () => undefined })
    const activity = vi.fn()
    await manager.restore(activity)

    await manager.adoptActive()

    expect(manager.remembered().map((run) => run.runId)).toEqual(['active'])
    expect(activity).toHaveBeenCalledWith(expect.objectContaining({ id: 'active', label: 'Inbox /research-inbox', status: 'running' }), 'active')
    expect(transport.activity).toHaveBeenCalledWith('active', 0, 100)
  })

  it('replays the activity of remembered runs after a restart so the sidebar can expand them', async () => {
    const stored: RememberedServerRun[] = [
      { runId: 'done', invocationId: 'done', lastSequence: 2, status: 'completed', updatedAt: '2026-09-13T10:00:03.000Z', label: 'Inbox /research' },
    ]
    const memory: ServerRunMemory = { load: async () => stored, save: async () => undefined }
    const transport = {
      activity: vi.fn(async () => ({
        events: [
          { id: 'thinking', sequence: 1, phase: 'complete' as const, kind: 'thinking' as const, label: 'Thinking' },
          { id: 'fetch', sequence: 2, phase: 'complete' as const, kind: 'tool' as const, label: 'web_fetch' },
        ],
        nextCursor: null, status: 'completed' as const,
      })),
      run: vi.fn(), runs: vi.fn(), invoke: vi.fn(), cancel: vi.fn(), retry: vi.fn(),
    } as unknown as ServerAgentTransport
    const manager = new ServerRunManager(transport, memory, { pollMs: 0, delay: async () => undefined })
    const activity = vi.fn()

    await manager.restore(activity)

    expect(transport.activity).toHaveBeenCalledWith('done', 0, 200)
    expect(activity.mock.calls.map(([event]) => event.id)).toEqual(['done', 'thinking', 'fetch'])
    expect(activity).toHaveBeenCalledWith(expect.objectContaining({ id: 'done', label: 'Inbox /research', status: 'success' }), 'done')
  })

  it('clears finished history while retaining active runs for restart recovery', async () => {
    let stored: RememberedServerRun[] = [
      { runId: 'done', invocationId: 'done-invocation', lastSequence: 3, status: 'completed', updatedAt: '2026-09-13T10:00:03.000Z' },
    ]
    const memory: ServerRunMemory = { load: async () => stored, save: async (runs) => { stored = structuredClone(runs) } }
    const transport = {
      invoke: vi.fn(async () => ({ runId: 'active', status: 'queued' as const, admittedAt: '2026-09-13T10:00:04.000Z' })),
      activity: vi.fn(() => new Promise<never>(() => undefined)),
      run: vi.fn(), cancel: vi.fn(), retry: vi.fn(),
    } as unknown as ServerAgentTransport
    const manager = new ServerRunManager(transport, memory)

    await manager.restore()
    await manager.invoke({ version: 2, invocationId: 'active-invocation', sourceNodeId: 'node', skillId: 'skill', prompt: '', acknowledgedOutlineRevision: 1 })
    await manager.clearFinishedHistory()

    expect(stored).toEqual([expect.objectContaining({ runId: 'active', status: 'queued' })])
    expect(manager.remembered()).toEqual([expect.objectContaining({ runId: 'active' })])
  })
})
