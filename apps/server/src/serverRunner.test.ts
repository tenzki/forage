import { createInitialOutlineState } from '@forage/domain'
import { repairSystemNodes } from '@forage/document'
// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverMcp } from '@forage/mcp-host'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelAdapter, RunInput, McpRunConnection } from '@forage/agent-runtime'
import {
  fauxAssistantMessage, fauxText, fauxToolCall, scriptedModel, type FauxResponseStep,
} from '@forage/pi-runtime/test-support'
import { requireBoundOutline, InMemoryServerRepository } from './repository'
import { InMemoryProviderCredentialStore, ServerCredentialService, type ResolvedModelCredential } from './credentialService'
import type { AgentEngine } from './config'
import { FileSystemAssetStorage } from './assets'
import { OpenAIImageAssetGenerator } from './imageGeneration'
import { createServerPiModel } from './piExecutor'
import { createServerToolRegistry } from './serverTools'
import { ServerAgentRunner, ServerAgentWorker, type ServerAgentRunnerOptions } from './serverRunner'

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

type CredentialKind = ResolvedModelCredential['provider']

interface FixtureOptions {
  mcpConnections?: McpRunConnection[]
  engine?: AgentEngine
  targetParentId?: string
  credentialKind?: CredentialKind
  /** The legacy engine's model. */
  model?: ModelAdapter
  /** The Pi engine's scripted model responses. */
  responses?: FauxResponseStep[]
  trigger?: 'manual' | 'inbox_automation'
  /** Tools the agent allows and the run may use. */
  toolIds?: string[]
  tools?: (repository: InMemoryServerRepository) => ServerAgentRunnerOptions['tools']
}

async function enroll(credentials: ServerCredentialService, ownerId: string, outlineId: string, kind: CredentialKind) {
  if (kind === 'openai') return (await credentials.enrollApiKey(ownerId, outlineId, 'sk-a-very-long-secret-api-key')).id
  return credentials.importCodexCredentialForTest(ownerId, outlineId, {
    accessToken: 'codex-access-token', refreshToken: 'codex-refresh-token', accountId: 'account-1',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  })
}

async function fixture(options: FixtureOptions = {}) {
  const repository = new InMemoryServerRepository({ instanceId: 'server' })
  const bootstrap = await bootstrapSeeded(repository, 'owner@test.invalid')
  const credentials = new ServerCredentialService(new InMemoryProviderCredentialStore(), { encryptionKeys: keys })
  const credentialId = await enroll(credentials, bootstrap.ownerId, bootstrap.outlineId, options.credentialKind ?? 'openai')
  const targetParentId = options.targetParentId ?? SEED_INBOX_ID
  const input: RunInput = {
    version: 1, runId: 'run-1', executionMode: 'server', outlineId: bootstrap.outlineId,
    source: { nodeId: bootstrap.inboxId, text: 'Source' }, target: { parentId: targetParentId },
    baseRevision: 0, configurationRevision: 1, credentialRef: credentialId,
    agent: { id: 'agent', name: 'Agent', description: 'Agent', systemPrompt: 'Work.', modelId: 'gpt-5', toolIds: options.toolIds ?? [] },
    skill: { id: 'skill', label: 'skill', description: 'Skill', systemPrompt: 'Write.', agentId: 'agent', requiredToolIds: [] },
    effectiveToolIds: options.toolIds ?? [], prompt: 'Run.', context: [],
    ...(options.mcpConnections ? { mcpSnapshot: options.mcpConnections.map(({ connection }) => connection) } : {}),
  }
  const trigger = options.trigger ?? 'manual'
  await repository.agentStore.admitRun({ input, ownerId: bootstrap.ownerId, trigger, triggerIdentity: `${trigger}:1`, maxAttempts: 2 })
  // The Pi engine builds the real model runtime for the credential, then answers from a script.
  const models: Array<{ provider: string; id: string }> = []
  const runner = new ServerAgentRunner({
    mcpConnections: options.mcpConnections,
    repository, credentials, tools: options.tools?.(repository) ?? [], workerId: 'worker', leaseMs: 30_000,
    engine: options.engine ?? 'pi',
    piModelFactory: async (credential, run) => {
      const { model } = await createServerPiModel(credential, run.input.agent.modelId)
      models.push({ provider: model.provider, id: model.id })
      return scriptedModel(options.responses ?? [])
    },
    ...(options.model ? { modelFactory: () => options.model! } : {}),
  })
  return { repository, runner, bootstrap, models }
}

function emitOutline(nodes: unknown[], sources: Array<{ url: string; label: string }> = []) {
  return fauxAssistantMessage(fauxToolCall('emit_outline', { nodes, sources }))
}

describe('backend MCP execution', () => {
  it('runs a discovered tool through Pi and commits the resulting outline with one attempt', async () => {
    const config = { command: process.execPath, args: [fileURLToPath(new URL('../../../packages/mcp-host/tests/fixture.mjs', import.meta.url))], env: { MCP_FIXTURE_STDIO: '1' } }
    const connection = await discoverMcp({ id: 'custom', name: 'Custom', environment: 'server' }, config)
    const tool = connection.tools[0]!
    const { repository, runner, bootstrap } = await fixture({
      mcpConnections: [{ connection, config }], toolIds: [tool.id], responses: [
        fauxAssistantMessage(fauxToolCall(tool.id, { message: 'Backend MCP worked' })),
        (context) => {
          expect(JSON.stringify(context.tools)).toContain('message')
          expect(JSON.stringify(context.messages.filter((message) => message.role === 'toolResult'))).toContain('Backend MCP worked')
          return emitOutline([{ text: 'Backend MCP worked' }])
        },
      ],
    })
    const claimed = await repository.agentStore.claimNext('worker', new Date(), 30_000)
    expect(claimed?.maxAttempts).toBe(1)
    await runner.execute(claimed!)
    expect(await repository.agentStore.getRun(bootstrap.outlineId, 'run-1')).toMatchObject({ status: 'completed', attemptCount: 1 })
    expect(await repository.agentStore.output('run-1')).toMatchObject({ result: { nodes: [{ text: 'Backend MCP worked' }] } })
  })
})

describe.each(['openai', 'openai-codex'] as const)('server agent runner on Pi with an %s credential', (credentialKind) => {
  it('runs a claimed immutable snapshot and commits agent-origin output exactly once', async () => {
    const { repository, runner, bootstrap, models } = await fixture({ credentialKind, responses: [emitOutline(
      [{ text: 'Result', children: [{ text: 'Child' }] }],
      [{ url: 'https://example.com', label: 'Example' }],
    )] })
    const claimed = await repository.agentStore.claimNext('worker', new Date(), 30_000)
    await runner.execute(claimed!)
    expect(models).toEqual([expect.objectContaining({ provider: credentialKind })])
    const run = await repository.agentStore.getRun(bootstrap.outlineId, 'run-1')
    expect(run).toMatchObject({ status: 'completed', result: { firstRevision: 1, lastRevision: 1 } })
    expect(await repository.agentStore.output('run-1')).toMatchObject({
      result: { nodes: [{ type: 'text', text: 'Result', children: [{ type: 'text', text: 'Child' }] }], sources: [] },
    })
    const events = await repository.eventsAfter(bootstrap.outlineId, 0, 10)
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('agent.result_committed')
    expect(events.every((event) => event.origin === 'agent' && event.agentProvenance?.runId === 'run-1')).toBe(true)
    await expect(repository.commitAgentResult('run-1', 'worker', {
      version: 1, nodes: [{ type: 'text', text: 'Result' }], sources: [],
    })).rejects.toThrow(/lease|requested|resource|different persisted output/i)
  })

  it('persists classified failures and retry availability', async () => {
    const { repository, runner, bootstrap } = await fixture({ credentialKind, responses: [
      fauxAssistantMessage([], { stopReason: 'error', errorMessage: 'temporary outage' }),
    ] })
    const claimed = await repository.agentStore.claimNext('worker', new Date(), 30_000)
    await runner.execute(claimed!)
    expect(await repository.agentStore.getRun(bootstrap.outlineId, 'run-1')).toMatchObject({
      status: 'retry_wait', errorCode: 'dependency_unavailable', attemptCount: 1,
    })
  })

  it('does not retry a credential the provider rejects', async () => {
    const { repository, runner, bootstrap } = await fixture({ credentialKind, responses: [
      fauxAssistantMessage([], { stopReason: 'error', errorMessage: '401 Incorrect API key provided: sk-a-very-long-secret-api-key' }),
    ] })
    await runner.execute((await repository.agentStore.claimNext('worker', new Date(), 30_000))!)
    const run = await repository.agentStore.getRun(bootstrap.outlineId, 'run-1')
    expect(run).toMatchObject({ status: 'failed', errorCode: 'authentication_required' })
    const { events } = await repository.agentStore.activity('run-1', 0, 100)
    expect(events.at(-1)).toMatchObject({ phase: 'error', label: 'authentication required' })
    expect(JSON.stringify(events)).not.toContain('sk-a-very-long')
  })

  it('fails an Inbox automation run that ends with prose instead of placing it', async () => {
    const { repository, runner, bootstrap } = await fixture({ credentialKind, trigger: 'inbox_automation', responses: [
      fauxAssistantMessage(fauxText('Plain prose.')),
    ] })
    await runner.execute((await repository.agentStore.claimNext('worker', new Date(), 30_000))!)
    expect(await repository.agentStore.getRun(bootstrap.outlineId, 'run-1')).toMatchObject({
      status: 'failed', errorCode: 'invalid_output',
    })
    expect(await repository.eventsAfter(bootstrap.outlineId, 0, 10)).toHaveLength(0)
  })

  it('retains completed output when placement is unavailable and places it exactly once later', async () => {
    const { repository, runner, bootstrap } = await fixture({ credentialKind, targetParentId: 'note_deleted', responses: [
      emitOutline([{ text: 'Recovered result', children: [{ text: 'Complete child' }] }]),
    ] })
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
})

describe('server agent runner image results', () => {
  const roots: string[] = []
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

  it('places a generated image as its stored content-addressed asset', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forage-runner-image-'))
    roots.push(root)
    const imageBytes = Buffer.from('RIFF\u0004\u0000\u0000\u0000WEBP', 'binary')
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(
      JSON.stringify({ data: [{ b64_json: imageBytes.toString('base64') }] }), { status: 200 },
    ))
    const { repository, runner, bootstrap } = await fixture({
      toolIds: ['generate_image'],
      tools: (repository) => (run, credential) => createServerToolRegistry({
        imageGeneration: (prompt, signal) => new OpenAIImageAssetGenerator({
          repository, storage: new FileSystemAssetStorage(root), credential, fetch,
          principal: {
            tokenId: 'worker', ownerId: run.ownerId, outlineId: run.outlineId, kind: 'device',
            scopes: ['agents:read', 'agents:execute'],
          },
        }).generate(prompt, signal),
      }),
      responses: [
        fauxAssistantMessage(fauxToolCall('generate_image', { prompt: 'An otter' })),
        (context) => {
          const results = JSON.stringify(context.messages.filter((message) => message.role === 'toolResult'))
          const imageId = /img_[a-f0-9]{32}/.exec(results)?.[0]
          return emitOutline([{ text: 'Otters' }, { imageId, imageAlt: 'A river otter' }])
        },
      ],
    })
    await runner.execute((await repository.agentStore.claimNext('worker', new Date(), 30_000))!)

    expect(await repository.agentStore.getRun(bootstrap.outlineId, 'run-1')).toMatchObject({ status: 'completed' })
    const [event] = await repository.eventsAfter(bootstrap.outlineId, 0, 10)
    const nodes = (event?.payload as { nodes: Array<Record<string, unknown>> }).nodes
    expect(nodes).toEqual([
      expect.objectContaining({ type: 'text', text: 'Otters' }),
      expect.objectContaining({ type: 'image', assetId: createHash('sha256').update(imageBytes).digest('hex'), alt: 'A river otter' }),
    ])
  })
})

describe('server agent runner on the legacy engine', () => {
  it('runs a claimed immutable snapshot and commits agent-origin output exactly once', async () => {
    const model: ModelAdapter = { invoke: vi.fn(async () => ({ type: 'structured_result' as const, result: {
      version: 1, nodes: [{ type: 'text', text: 'Result', children: [{ type: 'text', text: 'Child' }] }],
      sources: [{ url: 'https://example.com', label: 'Example' }],
    } })) }
    const { repository, runner, bootstrap } = await fixture({ engine: 'legacy', model })
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
    const { repository, runner, bootstrap } = await fixture({ engine: 'legacy', model })
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
    const { repository, runner, bootstrap } = await fixture({ engine: 'legacy', model, targetParentId: 'note_deleted' })
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
})

describe('server agent worker', () => {
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
