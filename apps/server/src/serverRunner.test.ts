// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { ModelAdapter, RunInput } from '@forage/agent-runtime'
import { InMemoryServerRepository } from './repository'
import { InMemoryProviderCredentialStore, ServerCredentialService } from './credentialService'
import { ServerAgentRunner, ServerAgentWorker } from './serverRunner'

const keys = [{ version: 1, keyBase64: Buffer.alloc(32, 5).toString('base64') }]

async function fixture(model: ModelAdapter) {
  const repository = new InMemoryServerRepository({ instanceId: 'server' })
  const bootstrap = await repository.bootstrapOwner('owner@test.invalid')
  const credentials = new ServerCredentialService(new InMemoryProviderCredentialStore(), { encryptionKeys: keys })
  const credential = await credentials.enrollApiKey(bootstrap.ownerId, bootstrap.outlineId, 'sk-a-very-long-secret-api-key')
  const input: RunInput = {
    version: 1, runId: 'run-1', executionMode: 'server', outlineId: bootstrap.outlineId,
    source: { nodeId: bootstrap.inboxId, text: 'Source' }, target: { parentId: bootstrap.inboxId },
    baseRevision: 0, configurationRevision: 1, credentialRef: credential.id,
    agent: { id: 'agent', name: 'Agent', description: 'Agent', systemPrompt: 'Work.', modelId: 'gpt-5', toolIds: [] },
    skill: { id: 'skill', label: 'skill', description: 'Skill', systemPrompt: 'Write.', agentId: 'agent', requiredToolIds: [] },
    effectiveToolIds: [], prompt: 'Run.', context: [],
  }
  await repository.agentStore.admitRun({ input, ownerId: bootstrap.ownerId, trigger: 'manual', triggerIdentity: 'manual:1', maxAttempts: 2 })
  const runner = new ServerAgentRunner({
    repository, credentials, tools: [], workerId: 'worker', leaseMs: 30_000,
    modelFactory: () => model,
  })
  return { repository, runner, bootstrap }
}

describe('server agent runner', () => {
  it('runs a claimed immutable snapshot and commits agent-origin output exactly once', async () => {
    const model: ModelAdapter = { invoke: vi.fn(async () => ({ type: 'structured_result' as const, result: {
      version: 1, nodes: [{ type: 'text', text: 'Result', children: [{ type: 'text', text: 'Child' }] }],
      sources: [{ url: 'https://example.com', label: 'Example' }],
    } })) }
    const { repository, runner, bootstrap } = await fixture(model)
    const claimed = await repository.agentStore.claimNext('worker', new Date(), 30_000)
    await runner.execute(claimed!)
    const run = await repository.agentStore.getRun(bootstrap.outlineId, 'run-1')
    expect(run).toMatchObject({ status: 'completed', result: { firstRevision: 1, lastRevision: 2 } })
    const events = await repository.eventsAfter(bootstrap.outlineId, 0, 10)
    expect(events).toHaveLength(2)
    expect(events.every((event) => event.origin === 'agent' && event.agentProvenance?.runId === 'run-1')).toBe(true)
    await expect(repository.commitAgentResult('run-1', 'worker', {
      version: 1, nodes: [{ type: 'text', text: 'Result' }], sources: [],
    })).rejects.toThrow(/lease|requested|resource/i)
  })

  it('persists classified failures and retry availability', async () => {
    const model: ModelAdapter = { invoke: vi.fn(async () => { throw new Error('temporary outage') }) }
    const { repository, runner, bootstrap } = await fixture(model)
    const claimed = await repository.agentStore.claimNext('worker', new Date(), 30_000)
    await runner.execute(claimed!)
    expect(await repository.agentStore.getRun(bootstrap.outlineId, 'run-1')).toMatchObject({
      status: 'retry_wait', errorCode: 'dependency_unavailable', attemptCount: 1,
    })
  })

  it('wakes a sleeping worker immediately for graceful shutdown', async () => {
    vi.useFakeTimers()
    const store = { claimNext: vi.fn(async () => null) }
    const worker = new ServerAgentWorker({
      store: store as never, runner: { execute: vi.fn() } as never,
      workerId: 'worker', concurrency: 1, pollMs: 60_000, leaseMs: 30_000,
    })
    try {
      worker.start()
      await vi.advanceTimersByTimeAsync(0)
      const stopping = worker.stop()
      await stopping
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      await vi.runAllTimersAsync()
      vi.useRealTimers()
    }
  })
})
