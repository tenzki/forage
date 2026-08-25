import { beforeEach, describe, expect, it, vi } from 'vitest'

const startupEvent = vi.hoisted(() => ({
  value: { type: 'process_error', error: 'Missing AI_CHAT_API_KEY' } as Record<string, unknown>,
}))
const createCommand = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: vi.fn(async () => '/tmp/ai-chat'),
  resolveResource: vi.fn(async (resource: string) => `/resources/${resource}`),
}))

vi.mock('@tauri-apps/plugin-shell', () => ({
  Command: {
    create: createCommand.mockImplementation(() => {
      const handlers = new Map<string, (value: unknown) => void>()
      let stdoutHandler: ((value: string) => void) | undefined
      return {
        stdout: { on: (_event: string, handler: (value: string) => void) => { stdoutHandler = handler } },
        stderr: { on: vi.fn() },
        on: (event: string, handler: (value: unknown) => void) => { handlers.set(event, handler) },
        spawn: async () => {
          stdoutHandler?.(`${JSON.stringify(startupEvent.value)}\n`)
          return { kill: vi.fn(), write: vi.fn(async () => undefined) }
        },
      }
    }),
  },
}))

import { PiRpcClient } from './piSdkClient'

beforeEach(() => createCommand.mockClear())

describe('Pi SDK startup', () => {
  it('rejects start immediately when the sidecar reports a startup error', async () => {
    const client = new PiRpcClient()

    await expect(client.start({
      provider: 'openai',
      modelId: 'gpt-test',
      apiKey: '',
      accountId: '',
    })).rejects.toThrow('Missing AI_CHAT_API_KEY')
    await client.stop()
  })

  it('resolves start only after the sidecar reports ready', async () => {
    startupEvent.value = { type: 'ready' }
    const client = new PiRpcClient()

    await expect(client.start({
      provider: 'openai',
      modelId: 'gpt-test',
      apiKey: 'test-key',
      accountId: '',
    })).resolves.toBeUndefined()
    await client.stop()
  })

  it('does not wait for an RPC response to start a run', async () => {
    startupEvent.value = { type: 'ready' }
    const client = new PiRpcClient()
    await client.start({
      provider: 'openai',
      modelId: 'gpt-test',
      apiKey: 'test-key',
      accountId: '',
    })

    const result = await Promise.race([
      client.prompt('payload').then(() => 'resolved'),
      new Promise<'timed out'>((resolve) => window.setTimeout(() => resolve('timed out'), 0)),
    ])

    expect(result).toBe('resolved')
    await client.stop()
  })

  it('passes OAuth expiry to the sidecar environment', async () => {
    startupEvent.value = { type: 'ready' }
    const client = new PiRpcClient()
    await client.start({
      provider: 'openai-codex',
      modelId: 'gpt-test',
      apiKey: 'access-token',
      accountId: 'account-id',
      oauthExpires: 2_000_000_000_000,
    })

    expect(createCommand).toHaveBeenCalledWith(
      'node-sidecar',
      expect.any(Array),
      expect.objectContaining({
        env: expect.objectContaining({ AI_CHAT_OAUTH_EXPIRES: '2000000000000' }),
      }),
    )
    await client.stop()
  })
})
