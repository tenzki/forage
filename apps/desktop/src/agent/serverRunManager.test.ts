import { describe, expect, it, vi } from 'vitest'
import type { ActivityEvent } from './activity'
import { applyActivityEvent } from './activityCalls'
import type { ServerAgentTransport } from './serverExecutor'
import { ServerRunManager, type RememberedServerRun, type ServerRunMemory } from './serverRunManager'
import { groupSkillCalls, skillCallThread } from './skillCalls'
import type { ActivityCall } from '../components/Agent/ActivitySidebar'

type Detail = Awaited<ReturnType<ServerAgentTransport['run']>>

function detail(id: string, overrides: Partial<Detail> = {}): Detail {
  return {
    id, outlineId: 'outline', trigger: 'manual', status: 'completed', skillId: 'research', policyId: null,
    configurationRevision: 1, attemptCount: 1, admittedAt: '2026-09-13T10:00:00.000Z', updatedAt: '2026-09-13T10:00:01.000Z',
    retryOfRunId: null, callId: null, turn: null, sourceNodeId: 'bullet', prompt: 'tides',
    error: null, result: null, placementError: null, answer: null, ...overrides,
  }
}

function memoryOf(initial: RememberedServerRun[] = []) {
  const state = { stored: initial }
  const memory: ServerRunMemory = { load: async () => state.stored, save: async (runs) => { state.stored = structuredClone(runs) } }
  return { state, memory }
}

/** Fold reported events into sidebar calls the way the app does. */
function sidebar() {
  let calls: ActivityCall[] = []
  let clock = 0
  const listener = (event: ActivityEvent) => { calls = applyActivityEvent(calls, event, ++clock) }
  return { listener, calls: () => calls }
}

describe('server run manager', () => {
  it('owns concurrent observations independently and persists cursors', async () => {
    let stored: RememberedServerRun[] = []
    const memory: ServerRunMemory = { load: async () => stored, save: async (runs) => { stored = structuredClone(runs) } }
    const transport = {
      invoke: vi.fn(async (intent) => ({ runId: intent.invocationId, status: 'queued' as const, admittedAt: '2026-09-13T10:00:00.000Z' })),
      activity: vi.fn(async (runId: string) => ({ events: [{ id: `event-${runId}`, sequence: 1, phase: 'complete' as const, kind: 'output' as const, label: 'Done' }], nextCursor: null, status: 'completed' as const })),
      run: vi.fn(async (runId: string) => ({ id: runId, outlineId: 'outline', trigger: 'manual' as const, status: 'completed' as const, skillId: 'skill', policyId: null, configurationRevision: 1, attemptCount: 1, admittedAt: '2026-09-13T10:00:00.000Z', updatedAt: '2026-09-13T10:00:01.000Z', retryOfRunId: null, error: null, result: null, placementError: null, callId: null, turn: null, sourceNodeId: 'node', prompt: 'One', answer: null })),
      cancel: vi.fn(async () => undefined), retry: vi.fn(), runs: vi.fn(), clearHistory: vi.fn(),
    } as ServerAgentTransport
    const manager = new ServerRunManager(transport, memory, { pollMs: 0, delay: async () => undefined })
    const activity = vi.fn()
    const first = await manager.invoke({ version: 2, invocationId: 'one', sourceNodeId: 'node', skillId: 'skill', prompt: 'One', acknowledgedOutlineRevision: 1 }, activity)
    const second = await manager.invoke({ version: 2, invocationId: 'two', sourceNodeId: 'node', skillId: 'skill', prompt: 'Two', acknowledgedOutlineRevision: 1 }, activity)
    await Promise.all([first.completion, second.completion])
    expect(stored.map((run) => run.runId).sort()).toEqual(['one', 'two'])
    expect(stored.every((run) => run.status === 'completed' && run.lastSequence === 1)).toBe(true)
    // Per run: its activity page, its call header and the output it wrote under the bullet.
    expect(activity).toHaveBeenCalledTimes(6)
    expect(activity.mock.calls.filter(([event]) => event.id === event.callId)).toHaveLength(2)
    expect(activity.mock.calls.filter(([event]) => event.kind === 'output' && event.nodeId === 'node')).toHaveLength(2)
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
    expect(activity).toHaveBeenCalledWith(expect.objectContaining({ id: 'fetch', callId: 'inbox', label: 'Read github.com' }))
    expect(activity).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'inbox', label: 'Inbox /research', status: 'complete', automation: true }))
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
    expect(activity).toHaveBeenCalledWith(expect.objectContaining({ id: 'active', label: 'Inbox /research-inbox', status: 'running' }))
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
    expect(activity).toHaveBeenCalledWith(expect.objectContaining({ id: 'done', label: 'Inbox /research', status: 'complete' }))
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

  it('routes a reply through its call and shows the answer in the call thread', async () => {
    const { memory } = memoryOf()
    const details = new Map<string, Detail>([
      ['run_first', detail('run_first', { callId: 'run_first', turn: 1 })],
      ['run_reply', detail('run_reply', { callId: 'run_first', turn: 2, prompt: 'Which part?', answer: 'The moon section.' })],
    ])
    const transport = {
      invoke: vi.fn(async (intent) => ({
        runId: intent.conversation ? 'run_reply' : 'run_first', status: 'queued' as const, admittedAt: '2026-09-13T10:00:00.000Z',
      })),
      activity: vi.fn(async () => ({ events: [], nextCursor: null, status: 'completed' as const })),
      run: vi.fn(async (runId: string) => details.get(runId)!),
      cancel: vi.fn(), retry: vi.fn(), runs: vi.fn(), clearHistory: vi.fn(),
    } as ServerAgentTransport
    const manager = new ServerRunManager(transport, memory, { pollMs: 0, delay: async () => undefined })
    const view = sidebar()

    const first = await manager.invoke(
      { version: 2, invocationId: 'first', sourceNodeId: 'bullet', skillId: 'research', prompt: 'tides', acknowledgedOutlineRevision: 1 },
      view.listener, { label: 'Run /research tides' },
    )
    await first.completion
    const reply = await manager.invoke({
      version: 2, invocationId: 'reply', sourceNodeId: 'bullet', skillId: 'research', prompt: 'Which part?',
      acknowledgedOutlineRevision: 2, conversation: { callId: 'run_first', turn: 2 },
    }, view.listener, { label: 'Run /research tides', note: 'Which part?' })
    await reply.completion

    expect(transport.invoke).toHaveBeenLastCalledWith(expect.objectContaining({ conversation: { callId: 'run_first', turn: 2 } }))
    const [group] = groupSkillCalls(view.calls())
    expect(group).toMatchObject({ title: '/research tides', conversational: true, versions: 1 })
    expect(skillCallThread(group!).map((item) => item.type === 'answer' ? `answer:${item.text}` : item.type))
      .toEqual(['output', 'note', 'answer:The moon section.'])
  })

  it('shows a replacing revision as the next version of the call', async () => {
    const { memory } = memoryOf()
    const details = new Map<string, Detail>([
      ['run_first', detail('run_first', { callId: 'run_first', turn: 1 })],
      ['run_reply', detail('run_reply', { callId: 'run_first', turn: 2, prompt: 'Shorter.' })],
    ])
    const transport = {
      invoke: vi.fn(async (intent) => ({
        runId: intent.conversation ? 'run_reply' : 'run_first', status: 'queued' as const, admittedAt: '2026-09-13T10:00:00.000Z',
      })),
      activity: vi.fn(async () => ({ events: [], nextCursor: null, status: 'completed' as const })),
      run: vi.fn(async (runId: string) => details.get(runId)!),
      cancel: vi.fn(), retry: vi.fn(), runs: vi.fn(), clearHistory: vi.fn(),
    } as ServerAgentTransport
    const manager = new ServerRunManager(transport, memory, { pollMs: 0, delay: async () => undefined })
    const view = sidebar()

    await (await manager.invoke(
      { version: 2, invocationId: 'first', sourceNodeId: 'bullet', skillId: 'research', prompt: 'tides', acknowledgedOutlineRevision: 1 },
      view.listener, { label: 'Run /research tides' },
    )).completion
    await (await manager.invoke({
      version: 2, invocationId: 'reply', sourceNodeId: 'bullet', skillId: 'research', prompt: 'Shorter.',
      acknowledgedOutlineRevision: 2, conversation: { callId: 'run_first', turn: 2 },
    }, view.listener, { label: 'Run /research tides', note: 'Shorter.' })).completion

    const [group] = groupSkillCalls(view.calls())
    expect(group?.versions).toBe(2)
    expect(skillCallThread(group!).filter((item) => item.type === 'output'))
      .toEqual([expect.objectContaining({ version: 1, superseded: true }), expect.objectContaining({ version: 2, superseded: false, resultNodeId: 'bullet' })])
  })

  it('shows turns of a call another device started, without adopting its own runs twice', async () => {
    const { memory } = memoryOf()
    let admit: (value: { runId: string; status: 'queued'; admittedAt: string }) => void = () => undefined
    const details = new Map<string, Detail>([
      ['run_elsewhere', detail('run_elsewhere', { status: 'running', callId: 'run_call', turn: 2, prompt: 'Which part?' })],
      ['run_mine', detail('run_mine', { status: 'running', callId: 'run_mine', turn: 1 })],
    ])
    const transport = {
      invoke: vi.fn(() => new Promise((resolve) => { admit = resolve })),
      activity: vi.fn(() => new Promise<never>(() => undefined)),
      run: vi.fn(async (runId: string) => details.get(runId)!),
      cancel: vi.fn(), retry: vi.fn(), runs: vi.fn(), clearHistory: vi.fn(),
    } as unknown as ServerAgentTransport
    const manager = new ServerRunManager(transport, memory, { skillLabel: () => 'research' })
    const view = sidebar()
    await manager.restore(view.listener)

    const invoking = manager.invoke(
      { version: 2, invocationId: 'mine', sourceNodeId: 'bullet', skillId: 'research', prompt: 'tides', acknowledgedOutlineRevision: 1 },
      view.listener, { label: 'Run /research tides' },
    )
    // The run's signal can arrive before this device learns its own run ID.
    const adopting = manager.adopt('run_mine')
    admit({ runId: 'run_mine', status: 'queued', admittedAt: '2026-09-13T10:00:00.000Z' })
    await Promise.all([invoking, adopting])
    await manager.adopt('run_elsewhere')

    expect(manager.remembered().map((run) => [run.runId, run.invocationId]).sort())
      .toEqual([['run_elsewhere', 'run_elsewhere'], ['run_mine', 'mine']])
    expect(view.calls().find((call) => call.id === 'run_elsewhere')).toMatchObject({
      label: 'Run /research', kind: 'skill', nodeId: 'bullet', note: 'Which part?',
      thread: { callId: 'run_call', turn: 2 }, status: 'running',
    })
  })

  it('restores call turns in order with their thread and answer after a restart', async () => {
    const { memory } = memoryOf([
      {
        runId: 'run_reply', invocationId: 'reply', lastSequence: 0, status: 'completed', updatedAt: '2026-09-13T10:00:05.000Z',
        label: 'Run /research tides', nodeId: 'bullet', thread: { callId: 'run_first', turn: 2 }, note: 'Why?', answer: 'Because.',
      },
      {
        runId: 'run_first', invocationId: 'first', lastSequence: 0, status: 'completed', updatedAt: '2026-09-13T10:00:01.000Z',
        label: 'Run /research tides', nodeId: 'bullet', thread: { callId: 'run_first', turn: 1 },
      },
    ])
    const transport = {
      activity: vi.fn(async () => ({ events: [], nextCursor: null, status: 'completed' as const })),
      run: vi.fn(), runs: vi.fn(), invoke: vi.fn(), cancel: vi.fn(), retry: vi.fn(), clearHistory: vi.fn(),
    } as unknown as ServerAgentTransport
    const manager = new ServerRunManager(transport, memory)
    const view = sidebar()

    await manager.restore(view.listener)

    const [group] = groupSkillCalls(view.calls())
    expect(group?.iterations.map(({ call }) => call.id)).toEqual(['first', 'reply'])
    expect(skillCallThread(group!).map((item) => item.type)).toEqual(['output', 'note', 'answer'])
  })

  it('clears finished calls on the server only in server mode', async () => {
    const { memory } = memoryOf([
      { runId: 'done', invocationId: 'done', lastSequence: 0, status: 'completed', updatedAt: '2026-09-13T10:00:03.000Z' },
    ])
    const transport = {
      clearHistory: vi.fn(async () => ({ deletedRuns: 1 })),
      activity: vi.fn(), run: vi.fn(), runs: vi.fn(), invoke: vi.fn(), cancel: vi.fn(), retry: vi.fn(),
    } as unknown as ServerAgentTransport
    const manager = new ServerRunManager(transport, memory)
    await manager.restore()

    await manager.clearFinishedHistory()
    expect(transport.clearHistory).not.toHaveBeenCalled()
    await manager.clearFinishedHistory({ server: true })
    expect(transport.clearHistory).toHaveBeenCalledTimes(1)
    expect(manager.remembered()).toEqual([])
  })
})
