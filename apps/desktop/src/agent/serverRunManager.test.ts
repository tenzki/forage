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
      cancel: vi.fn(async () => undefined), retry: vi.fn(),
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
})
