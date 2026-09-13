import { createInitialOutlineState } from '@forage/domain'
import { repairSystemNodes } from '@forage/document'
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { ModelAdapter, RunInput } from '@forage/agent-runtime'
import { requireBoundOutline, InMemoryServerRepository } from './repository'
import { InMemoryProviderCredentialStore, ServerCredentialService } from './credentialService'
import { ServerAgentRunner, ServerAgentWorker } from './serverRunner'

const keys = [{ version: 1, keyBase64: Buffer.alloc(32, 5).toString('base64') }]


const SEED_INBOX_ID = 'note_inbox'
const SEED_OUTLINE_ID = 'outline_seed'

function seedDocumentState(ids: { inbox: string; daily: string; bullet: string }) {
  const systemIds = [ids.inbox, ids.daily]
  const repaired = repairSystemNodes({
    type: 'doc',
    content: [{
      type: 'bulletList',
      content: [{
        type: 'listItem',
        attrs: {
          nodeId: ids.bullet, nodeType: 'user', collapsed: false, bulletKind: 'bullet',
          completed: false, systemRole: null, dailyDate: null,
        },
        content: [{ type: 'paragraph' }],
      }],
    }],
  }, () => systemIds.shift()!)
  return createInitialOutlineState(repaired.doc)
}

/** Bootstraps, claims, and seeds so a test starts from a ready outline. */
async function bootstrapSeeded(repository: InMemoryServerRepository, email = 'owner@test.invalid') {
  const bootstrap = await repository.bootstrapOwner(email)
  await repository.claimOutline(await repository.authenticate(bootstrap.deviceToken, 'sync'), {
    outlineId: SEED_OUTLINE_ID, name: 'Notes',
  })
  await repository.seedOutline(
    requireBoundOutline(requireBoundOutline(await repository.authenticate(bootstrap.deviceToken, 'sync'))),
    seedDocumentState({ inbox: SEED_INBOX_ID, daily: 'note_daily', bullet: 'note_bullet' }),
  )
  return { ...bootstrap, outlineId: SEED_OUTLINE_ID, inboxId: SEED_INBOX_ID }
}

async function fixture(model: ModelAdapter, targetParentId = SEED_INBOX_ID) {
  const repository = new InMemoryServerRepository({ instanceId: 'server' })
  const bootstrap = await bootstrapSeeded(repository, 'owner@test.invalid')
  const credentials = new ServerCredentialService(new InMemoryProviderCredentialStore(), { encryptionKeys: keys })
  const credential = await credentials.enrollApiKey(bootstrap.ownerId, bootstrap.outlineId, 'sk-a-very-long-secret-api-key')
  const input: RunInput = {
    version: 1, runId: 'run-1', executionMode: 'server', outlineId: bootstrap.outlineId,
    source: { nodeId: bootstrap.inboxId, text: 'Source' }, target: { parentId: targetParentId },
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
    expect(run).toMatchObject({ status: 'completed', result: { firstRevision: 1, lastRevision: 1 } })
    const events = await repository.eventsAfter(bootstrap.outlineId, 0, 10)
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('agent.result_committed')
    expect(events.every((event) => event.origin === 'agent' && event.agentProvenance?.runId === 'run-1')).toBe(true)
    await expect(repository.commitAgentResult('run-1', 'worker', {
      version: 1, nodes: [{ type: 'text', text: 'Result' }], sources: [],
    })).rejects.toThrow(/lease|requested|resource|different persisted output/i)
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

  it('retains completed output when placement is unavailable and places it exactly once later', async () => {
    const model: ModelAdapter = { invoke: vi.fn(async () => ({ type: 'structured_result' as const, result: {
      version: 1, nodes: [{ type: 'text', text: 'Recovered result', children: [{ type: 'text', text: 'Complete child' }] }], sources: [],
    } })) }
    const { repository, runner, bootstrap } = await fixture(model, 'note_deleted')
    await runner.execute((await repository.agentStore.claimNext('worker', new Date(), 30_000))!)
    expect(await repository.agentStore.getRun(bootstrap.outlineId, 'run-1')).toMatchObject({
      status: 'completed_unplaced', placementError: 'target_missing', result: null,
    })
    expect(await repository.agentStore.output('run-1')).toMatchObject({
      result: { nodes: [{ text: 'Recovered result', children: [{ text: 'Complete child' }] }] },
    })

    const principal = requireBoundOutline(await repository.authenticate(bootstrap.deviceToken, 'agents:execute'))
    const placed = await repository.placeAgentResult(principal, 'run-1', bootstrap.inboxId)
    expect(placed).toMatchObject({ firstRevision: 1, lastRevision: 1 })
    await expect(repository.placeAgentResult(principal, 'run-1', bootstrap.inboxId)).resolves.toEqual(placed)
    expect((await repository.eventsAfter(bootstrap.outlineId, 0, 10)).filter((event) => event.type === 'agent.result_committed')).toHaveLength(1)
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
