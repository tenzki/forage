// @vitest-environment node
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Transform } from '@tiptap/pm/transform'
import { captureStepBatch, createOutlineSchema, queryCanonicalOutline, repairSystemNodes } from '@forage/document'
import { canonicalJson, createInitialOutlineState, parseEventEnvelope, sha256Hex, type OutlineState } from '@forage/domain'
import type { RuntimeTool } from '@forage/agent-runtime'
import {
  fauxAssistantMessage, fauxText, fauxToolCall, scriptedModel, type Context, type FauxResponseStep,
} from '@forage/pi-runtime/test-support'
import { buildServer } from './app'
import { FileSystemAssetStorage } from './assets'
import { redactCredentialText, settledTurnEntries } from './callConversations'
import type { AgentEngine } from './config'
import { InMemoryProviderCredentialStore, ServerCredentialService } from './credentialService'
import { InMemoryServerRepository, requireBoundOutline } from './repository'
import { ServerAgentRunner } from './serverRunner'

const OUTLINE_ID = 'outline_test'
const CALL_BULLET = 'note_bullet'
const API_KEY = 'sk-a-very-long-secret-api-key'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())) })

function seedState(): OutlineState {
  const systemIds = ['note_inbox', 'note_daily']
  const repaired = repairSystemNodes({
    type: 'doc',
    content: [{
      type: 'bulletList',
      content: [{
        type: 'listItem',
        attrs: { nodeId: CALL_BULLET, nodeType: 'user', collapsed: false, bulletKind: 'bullet', completed: false, systemRole: null, dailyDate: null },
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Tides' }] }],
      }],
    }],
  }, () => systemIds.shift()!)
  return createInitialOutlineState(repaired.doc)
}

async function conversationServer(options: { engine?: AgentEngine; budget?: number; tools?: RuntimeTool[] } = {}) {
  const repository = new InMemoryServerRepository({ instanceId: 'instance-test' })
  const bootstrap = await repository.bootstrapOwner('owner@test.invalid')
  await repository.claimOutline(await repository.authenticate(bootstrap.deviceToken, 'sync'), { outlineId: OUTLINE_ID, name: 'Notes' })
  const device = requireBoundOutline(await repository.authenticate(bootstrap.deviceToken, 'sync'))
  await repository.seedOutline(device, seedState())
  const assetRoot = await mkdtemp(join(tmpdir(), 'forage-call-assets-'))
  const tempRoot = await mkdtemp(join(tmpdir(), 'forage-call-sessions-'))
  cleanups.push(() => rm(assetRoot, { recursive: true, force: true }), () => rm(tempRoot, { recursive: true, force: true }))
  const credentials = new ServerCredentialService(new InMemoryProviderCredentialStore(), {
    encryptionKeys: [{ version: 1, keyBase64: Buffer.alloc(32, 4).toString('base64') }],
  })
  const toolIds = (options.tools ?? []).map((tool) => tool.id)
  const serverFor = (engine: AgentEngine) => {
    const app = buildServer({
      repository, credentialService: credentials, supportedAgentToolIds: toolIds, logger: false,
      assetStorage: new FileSystemAssetStorage(assetRoot), agentEngine: engine,
      ...(options.budget === undefined ? {} : { conversationBudgetBytes: options.budget }),
    })
    cleanups.push(() => app.close())
    return app
  }
  const app = serverFor(options.engine ?? 'pi')
  const headers = { authorization: `Bearer ${bootstrap.deviceToken}` }
  await app.inject({
    method: 'PUT', url: `/api/v1/outlines/${OUTLINE_ID}/agent-configuration`, headers,
    payload: { baseRevision: 0, configuration: {
      version: 1, revision: 1,
      agents: [{ id: 'agent', name: 'Agent', description: 'Researcher', systemPrompt: 'Research.', modelId: 'gpt-5', toolIds }],
      skills: [{ id: 'research', label: 'research', description: 'Research', systemPrompt: 'Document.', agentId: 'agent', requiredToolIds: [] }],
      customTools: [], globallyEnabledToolIds: toolIds,
    } },
  })
  const credentialRef = (await app.inject({
    method: 'POST', url: `/api/v1/outlines/${OUTLINE_ID}/agent-credentials/api-key`, headers, payload: { provider: 'openai', apiKey: API_KEY },
  })).json().id
  await app.inject({
    method: 'PUT', url: `/api/v1/outlines/${OUTLINE_ID}/compute-profile`, headers,
    payload: { baseRevision: 0, profile: { version: 1, revision: 1, provider: 'openai', modelId: 'gpt-5', credentialRef } },
  })

  const scripts: FauxResponseStep[][] = []
  const runnerFor = (engine: AgentEngine) => new ServerAgentRunner({
    repository, credentials, tools: options.tools ?? [], workerId: 'worker', leaseMs: 30_000, engine,
    conversationTempRoot: tempRoot,
    piModelFactory: async () => scriptedModel(scripts.shift() ?? []),
    modelFactory: () => { throw new Error('The legacy model is not used in these tests.') },
  })
  const runner = runnerFor(options.engine ?? 'pi')
  let invocations = 0

  const admit = async (prompt: string, conversation?: { callId: string; turn: number }, target = app) => {
    invocations += 1
    return target.inject({
      method: 'POST', url: `/api/v1/outlines/${OUTLINE_ID}/agent-runs`, headers,
      payload: {
        version: 2, invocationId: `invocation-${invocations}`, sourceNodeId: CALL_BULLET, skillId: 'research', prompt,
        acknowledgedOutlineRevision: await repository.currentRevision(OUTLINE_ID),
        ...(conversation ? { conversation } : {}),
      },
    })
  }
  /** Claim the next queued run and execute it with the scripted model responses. */
  const work = async (responses: FauxResponseStep[], using = runner) => {
    scripts.push(responses)
    const run = await repository.agentStore.claimNext('worker', new Date(), 30_000)
    if (!run) throw new Error('No run was queued.')
    await using.execute(run)
    return (await app.inject({ method: 'GET', url: `/api/v1/outlines/${OUTLINE_ID}/agent-runs/${run.id}`, headers })).json()
  }
  const outlineTexts = async () => queryCanonicalOutline((await repository.checkpoint(OUTLINE_ID)).state).nodes().map((node) => node.text)
  return { app, serverFor, runnerFor, repository, device, headers, admit, work, outlineTexts, tempRoot }
}

function emitOutline(nodes: unknown[]) {
  return fauxAssistantMessage(fauxToolCall('emit_outline', { nodes, sources: [] }))
}

function userTexts(context: Context): string[] {
  return context.messages.flatMap((message) => (message.role === 'user'
    ? [typeof message.content === 'string' ? message.content : message.content.map((part) => (part.type === 'text' ? part.text : '')).join('')]
    : []))
}

async function deleteNode(repository: InMemoryServerRepository, device: ReturnType<typeof requireBoundOutline>, nodeId: string) {
  const checkpoint = await repository.checkpoint(OUTLINE_ID)
  const doc = createOutlineSchema().nodeFromJSON(checkpoint.state.doc)
  let range: { from: number; to: number } | undefined
  doc.descendants((node, pos) => {
    if (node.type.name === 'listItem' && node.attrs.nodeId === nodeId) range = { from: pos, to: pos + node.nodeSize }
  })
  const transform = new Transform(doc).delete(range!.from, range!.to)
  await repository.acceptEvents(device, checkpoint.revision, [parseEventEnvelope({
    id: `event-delete-${nodeId}`, outlineId: OUTLINE_ID, actorId: device.ownerId, deviceId: 'device-test',
    type: 'document.steps_applied', eventVersion: 1, documentVersion: 1, schemaEpoch: 1,
    baseRevision: checkpoint.revision, origin: 'desktop', occurredAt: new Date().toISOString(),
    payload: {
      ...captureStepBatch(doc, transform.steps),
      beforeHash: await sha256Hex(canonicalJson(doc.toJSON())),
      afterHash: await sha256Hex(canonicalJson(transform.doc.toJSON())),
    },
  })])
}

describe('server call conversations', () => {
  it('starts a call, answers a question inline, and revises the outline with one replacing event', async () => {
    const server = await conversationServer()
    const first = (await server.admit('Research tides.')).json().runId
    const placed = await server.work([emitOutline([{ text: 'Version 1' }])])
    expect(placed).toMatchObject({ id: first, status: 'completed', callId: first, turn: 1, answer: null })
    const revisionAfterFirst = await server.repository.currentRevision(OUTLINE_ID)

    let seen: Context | undefined
    const question = await server.admit('Which part matters most?', { callId: first, turn: 2 })
    expect(question.statusCode).toBe(202)
    const answered = await server.work([(context) => {
      seen = context
      return fauxAssistantMessage(fauxText('The moon section.'))
    }])
    expect(answered).toMatchObject({ status: 'completed', callId: first, turn: 2, answer: 'The moon section.', result: null })
    expect(userTexts(seen!)).toHaveLength(2)
    expect(userTexts(seen!)[0]).toContain('Research tides.')
    expect(userTexts(seen!)[1]).toContain('Which part matters most?')
    expect(userTexts(seen!)[1]).toContain('- [agent] Version 1')
    expect(await server.repository.currentRevision(OUTLINE_ID)).toBe(revisionAfterFirst)

    await server.admit('Make it one line about gravity.', { callId: first, turn: 3 })
    const revised = await server.work([(context) => {
      // Each worker rehydrates from stored entries. Turn three must retain both
      // the first tool-produced result and the second turn's inline answer.
      expect(userTexts(context)).toHaveLength(3)
      expect(JSON.stringify(context.messages.filter((message) => message.role === 'assistant')))
        .toContain('The moon section.')
      expect(JSON.stringify(context.messages.filter((message) => message.role === 'toolResult')))
        .toContain('Version 1')
      return emitOutline([{ text: 'Version 2' }])
    }])
    expect(revised).toMatchObject({ status: 'completed', callId: first, turn: 3 })
    const events = await server.repository.eventsAfter(OUTLINE_ID, revisionAfterFirst, 10)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'agent.result_committed', eventVersion: 2,
      payload: { replaces: { runId: first, rootNoteIds: placed.result.rootNoteIds } },
    })
    const texts = await server.outlineTexts()
    expect(texts).toContain('Version 2')
    expect(texts).not.toContain('Version 1')

    const list = await server.app.inject({ method: 'GET', url: `/api/v1/outlines/${OUTLINE_ID}/agent-runs`, headers: server.headers })
    expect(list.json().runs.map((run: { callId: string; turn: number }) => [run.callId, run.turn])).toEqual([[first, 3], [first, 2], [first, 1]])
    // Run views carry what another device needs to show the call's thread.
    expect(list.json().runs[1]).toMatchObject({ sourceNodeId: CALL_BULLET, prompt: 'Which part matters most?' })
    expect(list.json().runs[2].prompt).toBe('Research tides.')
    expect(await readdir(server.tempRoot)).toEqual([])
  })

  it('refuses a reply while the call is busy, for a turn already taken, and over the transcript budget', async () => {
    const server = await conversationServer()
    const first = (await server.admit('Research tides.')).json().runId
    const busy = await server.admit('Too soon.', { callId: first, turn: 2 })
    expect(busy.statusCode).toBe(409)
    expect(busy.json().error).toMatchObject({ code: 'call_busy', retryable: true })
    await server.work([emitOutline([{ text: 'Version 1' }])])

    expect((await server.admit('From device A.', { callId: first, turn: 2 })).statusCode).toBe(202)
    const otherDevice = await server.admit('From device B.', { callId: first, turn: 2 })
    expect(otherDevice.json().error.code).toBe('call_busy')
    await server.work([fauxAssistantMessage(fauxText('Answer for A.'))])
    const stale = await server.admit('Late from device B.', { callId: first, turn: 2 })
    expect(stale.statusCode).toBe(409)
    expect(stale.json().error.code).toBe('conflict')

    const small = await conversationServer({ budget: 256 })
    const call = (await small.admit('Research tides.')).json().runId
    await small.work([emitOutline([{ text: 'Version 1' }])])
    const runs = await small.repository.agentStore.listRuns(OUTLINE_ID, 10)
    const tooLarge = await small.admit('Continue.', { callId: call, turn: 2 })
    expect(tooLarge.statusCode).toBe(409)
    expect(tooLarge.json().error).toMatchObject({ code: 'conversation_too_large', recoveryAction: 'run_again' })
    expect(tooLarge.json().error.message).toMatch(/start a new call/i)
    expect(await small.repository.agentStore.listRuns(OUTLINE_ID, 10)).toHaveLength(runs.length)
  })

  it('refuses a reply to an unknown call or a first turn sent as a reply', async () => {
    const server = await conversationServer()
    const unknown = await server.admit('Hello?', { callId: 'run_missing', turn: 2 })
    expect(unknown.json().error.code).toBe('conversation_unavailable')
    const invalid = await server.admit('Hello?', { callId: 'run_missing', turn: 1 })
    expect(invalid.statusCode).toBe(400)
  })

  it('refuses replies after rolling back to the legacy engine and keeps the transcript', async () => {
    const server = await conversationServer()
    const first = (await server.admit('Research tides.')).json().runId
    await server.work([emitOutline([{ text: 'Version 1' }])])
    const stored = await server.repository.agentStore.conversationEntries(first, 2)
    expect(stored.length).toBeGreaterThan(0)

    const legacy = server.serverFor('legacy')
    const refused = await server.admit('Continue.', { callId: first, turn: 2 }, legacy)
    expect(refused.statusCode).toBe(409)
    expect(refused.json().error).toMatchObject({ code: 'conversation_unavailable', recoveryAction: 'run_again' })

    // A reply admitted before the rollback fails closed instead of running without its history.
    await server.admit('Continue.', { callId: first, turn: 2 })
    const failed = await server.work([], server.runnerFor('legacy'))
    expect(failed).toMatchObject({ status: 'failed', error: { code: 'conversation_unavailable', retryable: false } })
    expect(await server.repository.agentStore.conversationEntries(first, 2)).toEqual(stored)
  })

  it('records the turn and retains a revision unplaced when the invocation bullet is gone', async () => {
    const server = await conversationServer()
    const first = (await server.admit('Research tides.')).json().runId
    await server.work([emitOutline([{ text: 'Version 1' }])])
    await server.admit('Revise it.', { callId: first, turn: 2 })
    await deleteNode(server.repository, server.device, CALL_BULLET)
    const unplaced = await server.work([emitOutline([{ text: 'Version 2' }])])
    expect(unplaced).toMatchObject({ status: 'completed_unplaced', callId: first, turn: 2 })
    expect(await server.repository.agentStore.conversationEntries(first, 3)).not.toEqual([])
  })

  it('clears finished calls with their transcripts but keeps a call with a retained unplaced result', async () => {
    const server = await conversationServer()
    const finished = (await server.admit('Research tides.')).json().runId
    await server.work([emitOutline([{ text: 'Version 1' }])])
    await server.admit('Why?', { callId: finished, turn: 2 })
    await server.work([fauxAssistantMessage(fauxText('Gravity.'))])
    const retained = (await server.admit('Research waves.')).json().runId
    await deleteNode(server.repository, server.device, CALL_BULLET)
    await server.work([emitOutline([{ text: 'Waves' }])])

    const cleared = await server.app.inject({
      method: 'POST', url: `/api/v1/outlines/${OUTLINE_ID}/agent-runs/clear-history`, headers: server.headers,
    })
    expect(cleared.json()).toEqual({ deletedRuns: 2 })
    const remaining = await server.repository.agentStore.listRuns(OUTLINE_ID, 10)
    expect(remaining.map((run) => run.id)).toEqual([retained])
    expect(await server.repository.agentStore.conversationEntries(finished, 3)).toEqual([])
    expect(await server.repository.agentStore.conversationEntries(retained, 2)).not.toEqual([])
  })

  it('deletes finished transcripts past the age limit, after which replies start over', async () => {
    const server = await conversationServer()
    const first = (await server.admit('Research tides.')).json().runId
    await server.work([emitOutline([{ text: 'Version 1' }])])
    expect(await server.repository.agentStore.pruneConversations(new Date(Date.now() - 60_000))).toBe(0)
    expect(await server.repository.agentStore.pruneConversations(new Date(Date.now() + 60_000))).toBe(1)
    const reply = await server.admit('Continue.', { callId: first, turn: 2 })
    expect(reply.json().error.code).toBe('conversation_unavailable')
  })

  it('stores turns without credential values or credential-shaped text', async () => {
    const leaky: RuntimeTool = {
      id: 'web_read', name: 'Read webpage', description: 'Reads a page.',
      execute: async () => ({
        trust: 'untrusted', sourceType: 'webpage', canonicalUrl: 'https://example.com',
        content: `key ${API_KEY} and Authorization: Bearer abc.def.ghi and refresh_token=rotate-me`,
      }),
    }
    const server = await conversationServer({ tools: [leaky] })
    const first = (await server.admit('Research tides.')).json().runId
    await server.work([
      fauxAssistantMessage(fauxToolCall('web_read', { url: 'https://example.com' })),
      emitOutline([{ text: 'Version 1' }]),
    ])
    const stored = JSON.stringify(await server.repository.agentStore.conversationEntries(first, 2))
    expect(stored).toContain('[redacted]')
    for (const secret of [API_KEY, 'abc.def.ghi', 'rotate-me']) expect(stored).not.toContain(secret)
  })
})

describe('call transcript redaction', () => {
  it('redacts known values and credential patterns without touching ordinary words', () => {
    expect(redactCredentialText('task-list and desk-lamp stay', [])).toBe('task-list and desk-lamp stay')
    expect(redactCredentialText('token opaque-value-123', ['opaque-value-123'])).toBe('token [redacted]')
    expect(redactCredentialText('api_key=abc123 Bearer xyz')).toBe('api_key=[redacted] [redacted]')
    const turn = settledTurnEntries([{ nested: [{ text: `${API_KEY}` }] }], { provider: 'openai', apiKey: API_KEY })
    expect(turn.entries).toEqual([{ nested: [{ text: '[redacted]' }] }])
    expect(turn.entryBytes).toBe(Buffer.byteLength(JSON.stringify(turn.entries)))
  })
})
