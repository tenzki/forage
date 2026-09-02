import { describe, expect, it, vi } from 'vitest'
import type { ActivityEvent, RunInput, StructuredResult } from '@forage/agent-runtime'
import { LocalAgentExecutor, type LocalRunRepository } from './localExecutor'

function input(runId = 'run-1'): RunInput {
  return {
    version: 1, runId, executionMode: 'local', outlineId: 'outline-1',
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
  }
}

function repository(): LocalRunRepository & Record<string, ReturnType<typeof vi.fn>> {
  return {
    admitAgentRun: vi.fn(async () => undefined),
    beginAgentAttempt: vi.fn(async () => 1),
    appendAgentActivity: vi.fn(async (_runId: string, event: ActivityEvent) => event.sequence),
    agentActivityAfter: vi.fn(async () => []),
    agentRun: vi.fn(async () => null),
    cancelAgentRun: vi.fn(async () => undefined),
    settleAgentRun: vi.fn(async () => undefined),
    retryAgentRun: vi.fn(async () => undefined),
  }
}

const result: StructuredResult = {
  version: 1,
  nodes: [{ type: 'text', text: 'Final result' }],
  sources: [],
}

describe('LocalAgentExecutor', () => {
  it('persists admission, attempt, activity, and one validated terminal result', async () => {
    const repo = repository()
    const runner = vi.fn(async (_input: RunInput, options: { onActivity: (event: ActivityEvent) => Promise<void> }) => {
      await options.onActivity({ id: 'activity-1', sequence: 1, phase: 'start', kind: 'thinking', label: 'Thinking' })
      return result
    })
    const executor = new LocalAgentExecutor(repo, runner, () => '2026-08-31T10:00:00.000Z')
    const onActivity = vi.fn()

    const handle = await executor.invoke(input(), { onActivity })
    await expect(handle.completion).resolves.toEqual(result)

    expect(repo.admitAgentRun).toHaveBeenCalledWith(expect.objectContaining({ id: 'run-1', status: 'queued' }))
    expect(repo.beginAgentAttempt).toHaveBeenCalledWith('run-1', '2026-08-31T10:00:00.000Z')
    expect(repo.appendAgentActivity).toHaveBeenCalledWith('run-1', expect.objectContaining({ sequence: 1 }), '2026-08-31T10:00:00.000Z')
    expect(onActivity).toHaveBeenCalledWith(expect.objectContaining({ sequence: 1 }))
    expect(repo.settleAgentRun).toHaveBeenCalledWith(
      'run-1', 'completed', 'result:run-1', result, null, '2026-08-31T10:00:00.000Z',
    )
  })

  it('durably cancels and aborts an active runtime', async () => {
    const repo = repository()
    const runner = vi.fn((_input: RunInput, options: { signal: AbortSignal }) => new Promise<StructuredResult>((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true })
    }))
    const executor = new LocalAgentExecutor(repo, runner, () => '2026-08-31T10:00:00.000Z')
    const handle = await executor.invoke(input())

    await handle.cancel()
    await expect(handle.completion).rejects.toMatchObject({ name: 'AbortError' })
    expect(repo.cancelAgentRun).toHaveBeenCalledWith('run-1', '2026-08-31T10:00:00.000Z')
    expect(repo.settleAgentRun).not.toHaveBeenCalledWith('run-1', 'completed', expect.anything(), expect.anything(), expect.anything(), expect.anything())
  })

  it('settles failures with a sanitized code and creates linked retries', async () => {
    const repo = repository()
    const failure = new Error('provider failed with sk-private')
    const executor = new LocalAgentExecutor(repo, async () => { throw failure }, () => '2026-08-31T10:00:00.000Z')
    const first = await executor.invoke(input())
    await expect(first.completion).rejects.toBe(failure)
    expect(repo.settleAgentRun).toHaveBeenCalledWith(
      'run-1', 'failed', null, null, 'execution_failed', '2026-08-31T10:00:00.000Z',
    )

    const succeeding = new LocalAgentExecutor(repo, async () => result, () => '2026-08-31T10:00:00.000Z')
    const retried = await succeeding.retry('run-1', input('run-2'))
    await expect(retried.completion).resolves.toEqual(result)
    expect(repo.retryAgentRun).toHaveBeenCalledWith('run-1', expect.objectContaining({
      id: 'run-2', retryOfRunId: 'run-1', status: 'queued',
    }))
  })

  it('rejects server snapshots rather than changing execution authority', async () => {
    const repo = repository()
    const executor = new LocalAgentExecutor(repo, async () => result)
    await expect(executor.invoke({ ...input(), executionMode: 'server' })).rejects.toThrow(/local/i)
    expect(repo.admitAgentRun).not.toHaveBeenCalled()
  })
})
