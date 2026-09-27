import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  InMemoryCredentialStore,
  type Context,
  type FauxResponseStep,
  type ModelsStoreEntry,
} from '@earendil-works/pi-ai'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { UNTRUSTED_MATERIAL_RULE, VERIFIED_CITATION_RULE } from '@forage/pi-runtime'

const transport = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('undici', () => ({ fetch: transport.fetch }))

import { runCommand } from './run'

type Emitted = Record<string, unknown>

async function scriptedModel(responses: FauxResponseStep[]) {
  const faux = fauxProvider()
  const entries = new Map<string, ModelsStoreEntry>()
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsStore: {
      read: async (providerId) => entries.get(providerId),
      write: async (providerId, entry) => { entries.set(providerId, entry) },
      delete: async (providerId) => { entries.delete(providerId) },
    },
    allowModelNetwork: false,
    refreshOnCreate: false,
  })
  modelRuntime.registerNativeProvider(faux.provider)
  faux.setResponses(responses)
  return { modelRuntime, model: faux.getModel() }
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

const payload = {
  runId: 'run-1', instructions: 'Research the topic.', prompt: 'tides',
  context: ['- Oceans'], enabledToolIds: ['web_fetch'], requiredToolIds: [], customTools: [],
}

let agentDir: string

async function run(responses: FauxResponseStep[], value: unknown, signal = new AbortController().signal): Promise<Emitted[]> {
  const events: Emitted[] = []
  const { modelRuntime, model } = await scriptedModel(responses)
  await runCommand(encode(value), {
    modelRuntime, model, accessToken: 'sk-secret-token', agentDir, signal,
    emit: (event) => { events.push(event as Emitted) },
  })
  return events
}

function settled(events: Emitted[]): Emitted | undefined {
  return events.find((event) => event.type === 'agent_settled' || event.type === 'process_error')
}

describe('sidecar run on the shared Pi turn', () => {
  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), 'forage-sidecar-run-'))
    transport.fetch.mockReset()
    transport.fetch.mockImplementation(async () => new Response('Tides follow the moon.', { status: 200 }))
  })

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true })
  })

  it('applies the shared prompt rules and drops sources the run did not read', async () => {
    let seen: Context | undefined
    const events = await run([
      (context) => {
        seen = context
        return fauxAssistantMessage(fauxToolCall('web_fetch', { url: 'https://example.com/tides' }))
      },
      fauxAssistantMessage(fauxToolCall('emit_outline', {
        nodes: [{ text: 'Tides follow the moon.' }],
        sources: [
          { url: 'https://example.com/tides', label: 'Read page' },
          { url: 'https://example.com/unread', label: 'Search lead' },
        ],
      })),
    ], payload)

    expect(seen?.systemPrompt).toContain(UNTRUSTED_MATERIAL_RULE)
    expect(seen?.systemPrompt).toContain(VERIFIED_CITATION_RULE)
    expect(seen?.tools?.map((tool) => tool.name)).toEqual(['web_fetch', 'emit_outline'])
    const emitted = events.find((event) => event.type === 'tool_execution_end' && event.toolName === 'emit_outline')
    expect(emitted?.result).toMatchObject({
      details: {
        action: 'emit_outline',
        nodes: [{ text: 'Tides follow the moon.' }],
        sources: [{ url: 'https://example.com/tides', label: 'Read page' }],
      },
    })
    expect(settled(events)).toEqual({ type: 'agent_settled', outcome: 'outline' })
  })

  it('reports first-turn text and resumes the stored call conversation with an answer', async () => {
    const thread = { callId: 'call-1', turn: 1 }
    const first = await run([fauxAssistantMessage(fauxText('Tides follow the moon.'))], { ...payload, thread })
    expect(events(first, 'message_update').length).toBeGreaterThan(0)
    expect(settled(first)).toEqual({ type: 'agent_settled', outcome: 'text', text: 'Tides follow the moon.' })

    let seen: Context | undefined
    const reply = await run([(context) => {
      seen = context
      return fauxAssistantMessage(fauxText('From the moon section.'))
    }], { ...payload, prompt: 'Which part?', thread: { callId: 'call-1', turn: 2 } })

    expect(seen?.messages.filter((message) => message.role === 'user')).toHaveLength(2)
    expect(settled(reply)).toEqual({ type: 'agent_settled', outcome: 'text', text: 'From the moon section.' })
  })

  it('settles an empty turn without text so the desktop retries it', async () => {
    const events = await run([fauxAssistantMessage([])], payload)
    expect(settled(events)).toEqual({ type: 'agent_settled', outcome: 'text' })
  })

  it('settles a cancelled turn as text', async () => {
    const controller = new AbortController()
    transport.fetch.mockImplementation(async () => {
      controller.abort()
      throw new DOMException('Aborted', 'AbortError')
    })
    const events = await run([
      fauxAssistantMessage(fauxToolCall('web_fetch', { url: 'https://example.com/tides' })),
      fauxAssistantMessage(fauxText('never')),
    ], payload, controller.signal)
    expect(settled(events)).toEqual({ type: 'agent_settled', outcome: 'text' })
  })

  it('requires an installed image extension even when generate_image is authorized', async () => {
    const events = await run([], { ...payload, enabledToolIds: ['generate_image'], requiredToolIds: ['generate_image'] })
    expect(settled(events)).toEqual({ type: 'process_error', error: 'Required tool is unavailable: generate_image' })
  })
})

function events(all: Emitted[], type: string): Emitted[] {
  return all.filter((event) => event.type === type)
}
