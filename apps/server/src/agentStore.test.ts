// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { AgentConfiguration, RunInput } from '@forage/agent-runtime'
import type { AutomationPolicySet } from '@forage/protocol'
import { AgentStoreError, InMemoryAgentStore } from './agentStore'

const configuration: AgentConfiguration = {
  version: 1, revision: 1,
  agents: [{ id: 'agent', name: 'Agent', description: 'Researcher', systemPrompt: 'Research.', modelId: 'gpt-5', toolIds: ['web_read'] }],
  skills: [{ id: 'research', label: 'research', description: 'Research', systemPrompt: 'Document.', agentId: 'agent', requiredToolIds: ['web_read'] }],
  customTools: [], globallyEnabledToolIds: ['web_read'],
}

const policies: AutomationPolicySet = { version: 1, revision: 1, enabled: true, policies: [{
  id: 'web', name: 'Web', enabled: true, priority: 1, match: { urlTypes: ['webpage'] }, skillIds: ['research'],
  dispatcher: { enabled: false, allowedSkillIds: [] },
}] }

function input(runId = 'run-1'): RunInput {
  return {
    version: 1, runId, executionMode: 'server', outlineId: 'outline-1',
    source: { nodeId: 'source-1', text: 'https://example.com' }, target: { parentId: 'source-1' },
    baseRevision: 5, configurationRevision: 1, credentialRef: 'credential-1',
    agent: configuration.agents[0]!, skill: configuration.skills[0]!, effectiveToolIds: ['web_read'],
    prompt: 'Research the source.', context: ['Parent'],
  }
}

describe('in-memory agent store', () => {
  it('publishes immutable configuration and policy revisions with compare-and-swap', async () => {
    const store = new InMemoryAgentStore()
    await expect(store.publishConfiguration('outline-1', 0, configuration)).resolves.toMatchObject({ configuration })
    await expect(store.publishConfiguration('outline-1', 0, configuration)).rejects.toBeInstanceOf(AgentStoreError)
    await store.publishAutomation('outline-1', 0, policies)
    const read = await store.currentConfiguration('outline-1')
    configuration.agents[0]!.name = 'mutated'
    expect(read?.configuration.agents[0]?.name).toBe('Agent')
  })

  it('admits immutable snapshots idempotently and pages ordered activity', async () => {
    const store = new InMemoryAgentStore()
    const admitted = await store.admitRun({ input: input(), trigger: 'manual', triggerIdentity: 'manual:key', maxAttempts: 3 })
    expect((await store.admitRun({ input: input('run-other'), trigger: 'manual', triggerIdentity: 'manual:key', maxAttempts: 3 })).id).toBe(admitted.id)
    const original = input(); original.prompt = 'changed'
    expect((await store.getRun('outline-1', admitted.id))?.input.prompt).toBe('Research the source.')
    await store.appendActivity(admitted.id, { id: 'a', sequence: 99, phase: 'start', kind: 'status', label: 'Queued' })
    await store.appendActivity(admitted.id, { id: 'b', sequence: 99, phase: 'complete', kind: 'status', label: 'Claimed' })
    expect((await store.activity(admitted.id, 0, 1)).events[0]?.sequence).toBe(1)
    expect((await store.activity(admitted.id, 1, 10)).events[0]?.sequence).toBe(2)
  })

  it('claims once, recovers expired leases, observes cancellation, and exhausts attempts', async () => {
    const store = new InMemoryAgentStore()
    await store.admitRun({ input: input(), trigger: 'manual', triggerIdentity: 'manual:1', maxAttempts: 2 })
    const first = await store.claimNext('worker-a', new Date('2030-01-01T00:00:00Z'), 1_000)
    expect(first?.attemptCount).toBe(1)
    expect(await store.claimNext('worker-b', new Date('2030-01-01T00:00:00.500Z'), 1_000)).toBeNull()
    const second = await store.claimNext('worker-b', new Date('2030-01-01T00:00:02Z'), 1_000)
    expect(second?.attemptCount).toBe(2)
    expect(await store.renewLease(second!.id, 'worker-b', new Date('2030-01-01T00:00:02.100Z'), 1_000)).toEqual({ owned: true, cancelRequested: false })
    await store.requestCancellation('outline-1', second!.id, new Date('2030-01-01T00:00:02.200Z'))
    expect(await store.renewLease(second!.id, 'worker-b', new Date('2030-01-01T00:00:02.300Z'), 1_000)).toEqual({ owned: true, cancelRequested: true })
    await store.finishCancelled(second!.id, 'worker-b')
    expect((await store.getRun('outline-1', second!.id))?.status).toBe('cancelled')
  })

  it('settles terminal states exactly once and creates linked user retries', async () => {
    const store = new InMemoryAgentStore()
    const run = await store.admitRun({ input: input(), trigger: 'manual', triggerIdentity: 'manual:1', maxAttempts: 1 })
    await store.claimNext('worker', new Date(), 10_000)
    const result = { firstRevision: 6, lastRevision: 7, rootNoteIds: ['note-result'] }
    await store.complete(run.id, 'worker', 'result:run-1', result)
    await expect(store.complete(run.id, 'worker', 'result:run-1', result)).resolves.toEqual(result)
    await expect(store.complete(run.id, 'worker', 'other', result)).rejects.toBeInstanceOf(AgentStoreError)
    const failed = await store.admitRun({ input: input('run-failed'), trigger: 'manual', triggerIdentity: 'manual:failed', maxAttempts: 1 })
    await store.claimNext('worker', new Date(Date.now() + 1), 10_000)
    await store.fail(failed.id, 'worker', 'invalid_output', false, new Date(), 0)
    const retry = await store.retry('outline-1', failed.id, input('run-2'), 2)
    expect(retry.retryOfRunId).toBe(failed.id)
    expect(retry.status).toBe('queued')
  })
})
