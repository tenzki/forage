import { describe, expect, it, vi } from 'vitest'
import type { RunInput } from '@forage/agent-runtime'
import { ServerAgentExecutor, TauriServerAgentTransport } from './serverExecutor'

function input(): RunInput {
  return {
    version: 1, runId: 'run-client', executionMode: 'server', outlineId: 'outline-1',
    source: { nodeId: 'source-1', text: 'Source' }, target: { parentId: 'source-1' },
    baseRevision: 3, configurationRevision: 2, credentialRef: 'credential-1',
    agent: { id: 'agent', name: 'Agent', description: 'Agent', systemPrompt: 'Work.', modelId: 'gpt-5', toolIds: [] },
    skill: { id: 'skill', label: 'skill', description: 'Skill', systemPrompt: 'Write.', agentId: 'agent', requiredToolIds: [] },
    effectiveToolIds: [], prompt: 'Run.', context: [],
  }
}

describe('server agent executor', () => {
  it('uses narrow native commands and resolves only after a terminal server result', async () => {
    const invoke = vi.fn(async (command: string) => {
      if (command === 'server_agent_invoke') return { runId: 'run-server', status: 'queued', admittedAt: '2026-08-31T10:00:00.000Z' }
      if (command === 'server_agent_activity') return { events: [{ id: 'a', sequence: 1, phase: 'complete', kind: 'status', label: 'Queued', status: 'success' }], nextCursor: null, status: 'running' }
      if (command === 'server_agent_run') return {
        id: 'run-server', outlineId: 'outline-1', trigger: 'manual', status: 'completed', skillId: 'skill', configurationRevision: 2,
        policyId: null, attemptCount: 1, admittedAt: '2026-08-31T10:00:00.000Z', updatedAt: '2026-08-31T10:01:00.000Z', retryOfRunId: null,
        error: null, result: { firstRevision: 4, lastRevision: 5, rootNoteIds: ['result-1'] },
      }
      throw new Error(`unexpected ${command}`)
    })
    const transport = new TauriServerAgentTransport(invoke)
    const activity = vi.fn()
    const executor = new ServerAgentExecutor(transport, { pollMs: 0, delay: async () => {} })
    const handle = await executor.invoke(input(), { onActivity: activity })
    await expect(handle.completion).resolves.toMatchObject({ status: 'completed', result: { firstRevision: 4 } })
    expect(activity).toHaveBeenCalledWith(expect.objectContaining({ sequence: 1 }))
    expect(invoke).toHaveBeenCalledWith('server_agent_invoke', expect.objectContaining({ idempotencyKey: 'run-client' }))
  })

  it('rejects local snapshots and never falls back when native admission fails', async () => {
    const invoke = vi.fn(async () => { throw new Error('server unavailable') })
    const executor = new ServerAgentExecutor(new TauriServerAgentTransport(invoke))
    await expect(executor.invoke({ ...input(), executionMode: 'local' })).rejects.toThrow(/server/i)
    await expect(executor.invoke(input())).rejects.toThrow('server unavailable')
    expect(invoke).toHaveBeenCalledTimes(1)
  })
})
