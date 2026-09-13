import { describe, expect, it, vi } from 'vitest'
import { dispatchStreamFrame, type ServerStreamHandlers } from './serverStream'

function handlers(): ServerStreamHandlers & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    onBatch: (batch) => calls.push(`batch:${batch.fromRevision}-${batch.toRevision}:${batch.events.length}`),
    onResync: () => calls.push('resync'),
    onAgent: (signal) => calls.push(`agent:${signal.runId}:${signal.activitySeq}:${signal.status}`),
    onAuthFailed: (status) => calls.push(`auth:${status}`),
    onConnected: () => calls.push('connected'),
    onDisconnected: (reason) => calls.push(`disconnected:${reason}`),
  }
}

const event = {
  id: 'event-5', outlineId: 'outline-1', actorId: 'owner-1', deviceId: 'device-1',
  type: 'note.created', eventVersion: 1, documentVersion: 1, schemaEpoch: 1,
  baseRevision: 4, revision: 5, origin: 'desktop', occurredAt: '2026-09-13T12:00:00.000Z',
  payload: { noteId: 'note-5', parentId: 'inbox', text: 'note 5' },
}

describe('server stream frames', () => {
  it('forwards a batch of authoritative events', () => {
    const sink = handlers()
    dispatchStreamFrame({ type: 'events', fromRevision: 4, toRevision: 5, events: [event] }, sink)
    expect(sink.calls).toEqual(['batch:4-5:1'])
  })

  it('treats an explicit resynchronization request as a pull', () => {
    const sink = handlers()
    dispatchStreamFrame({ type: 'resync', currentRevision: 900 }, sink)
    expect(sink.calls).toEqual(['resync'])
  })

  it('reports the stream coming back so the client can catch up on what it missed', () => {
    const sink = handlers()
    dispatchStreamFrame({ type: 'stream_connected' }, sink)
    expect(sink.calls).toEqual(['connected'])
  })

  it('relays agent activity without disturbing the outline cursor', () => {
    const sink = handlers()
    dispatchStreamFrame({ type: 'agent', runId: 'run-1', activitySeq: 3, status: 'running' }, sink)
    expect(sink.calls).toEqual(['agent:run-1:3:running'])
  })

  it('reports a refusal that retrying cannot fix', () => {
    const sink = handlers()
    dispatchStreamFrame({ type: 'stream_auth_failed', status: 401 }, sink)
    expect(sink.calls).toEqual(['auth:401'])
  })

  it('reports a dropped connection without asking for a pull', () => {
    const sink = handlers()
    dispatchStreamFrame({ type: 'stream_disconnected', reason: 'the server closed the stream' }, sink)
    expect(sink.calls).toEqual(['disconnected:the server closed the stream'])
  })

  it('ignores acknowledgements, heartbeats, and anything it cannot parse', () => {
    const sink = handlers()
    dispatchStreamFrame({ type: 'ready', currentRevision: 4 }, sink)
    dispatchStreamFrame({ type: 'pong' }, sink)
    dispatchStreamFrame({ type: 'unknown' }, sink)
    dispatchStreamFrame({ type: 'events', fromRevision: 4 }, sink)
    dispatchStreamFrame('not a frame', sink)
    dispatchStreamFrame(null, sink)
    expect(sink.calls).toEqual([])
  })

  it('rejects a batch carrying a malformed event rather than passing it on', () => {
    const sink = handlers()
    dispatchStreamFrame({
      type: 'events', fromRevision: 4, toRevision: 5,
      events: [{ ...event, type: 'note.created', payload: undefined }],
    }, sink)
    expect(sink.calls).toEqual([])
  })
})

describe('agent run signals', () => {
  it('wakes an observer and leaves nothing registered afterwards', async () => {
    const { AgentRunSignals, waitForAgentRunSignal } = await import('../agent/agentRunSignals')
    const signals = new AgentRunSignals()
    const never = new Promise<void>(() => undefined)
    const waiting = waitForAgentRunSignal(signals, 'run-1', never)
    await vi.waitFor(() => expect(signals.waiting('run-1')).toBe(1))

    signals.notify('run-1')
    await waiting

    expect(signals.waiting('run-1')).toBe(0)
  })

  it('falls back to the timer when no signal arrives', async () => {
    const { AgentRunSignals, waitForAgentRunSignal } = await import('../agent/agentRunSignals')
    const signals = new AgentRunSignals()
    await waitForAgentRunSignal(signals, 'run-2', Promise.resolve())
    expect(signals.waiting('run-2')).toBe(0)
  })

  it('wakes every observer when the stream comes back, because any run may have moved', async () => {
    const { AgentRunSignals, waitForAgentRunSignal } = await import('../agent/agentRunSignals')
    const signals = new AgentRunSignals()
    const never = new Promise<void>(() => undefined)
    const first = waitForAgentRunSignal(signals, 'run-a', never)
    const second = waitForAgentRunSignal(signals, 'run-b', never)
    await vi.waitFor(() => expect(signals.waiting('run-b')).toBe(1))

    signals.notifyAll()
    await Promise.all([first, second])

    expect(signals.waiting('run-a')).toBe(0)
    expect(signals.waiting('run-b')).toBe(0)
  })

  it('waits a minute while the stream is live and seconds while it is not', async () => {
    const { AGENT_POLL_MS, AGENT_STREAM_BACKSTOP_MS, agentWaitMs } = await import('../agent/agentRunSignals')
    expect(agentWaitMs('live')).toBe(AGENT_STREAM_BACKSTOP_MS)
    expect(agentWaitMs('down')).toBe(AGENT_POLL_MS)
    expect(agentWaitMs('unsupported')).toBe(AGENT_POLL_MS)
  })

  it('does not wake observers of a different run', async () => {
    const { AgentRunSignals, waitForAgentRunSignal } = await import('../agent/agentRunSignals')
    const signals = new AgentRunSignals()
    const never = new Promise<void>(() => undefined)
    const waiting = waitForAgentRunSignal(signals, 'run-3', never)
    signals.notify('run-other')
    expect(signals.waiting('run-3')).toBe(1)
    signals.notify('run-3')
    await waiting
  })
})
