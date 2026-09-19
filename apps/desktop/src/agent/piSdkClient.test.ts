import { beforeEach, describe, expect, it, vi } from 'vitest'

const startupEvent = vi.hoisted(() => ({
  value: { type: 'process_error', error: 'Missing AI_CHAT_API_KEY' } as Record<string, unknown>,
}))
const createCommand = vi.hoisted(() => vi.fn())
const childKill = vi.hoisted(() => vi.fn(async () => undefined))
let stderrHandler: ((value: string) => void) | undefined

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
        stderr: { on: (_event: string, handler: (value: string) => void) => { stderrHandler = handler } },
        on: (event: string, handler: (value: unknown) => void) => { handlers.set(event, handler) },
        spawn: async () => {
          stdoutHandler?.(`${JSON.stringify(startupEvent.value)}\n`)
          return { kill: childKill, write: vi.fn(async () => undefined) }
        },
      }
    }),
  },
}))

import { PiRpcClient } from './piSdkClient'

beforeEach(() => {
  createCommand.mockClear()
  childKill.mockClear()
  stderrHandler = undefined
})

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
      ['/resources/resources/pi/sidecar/dist/index.mjs'],
      expect.objectContaining({
        env: expect.objectContaining({ AI_CHAT_OAUTH_EXPIRES: '2000000000000' }),
      }),
    )
    await client.stop()
  })

  it('terminates an unresponsive run after the cancellation grace period', async () => {
    vi.useFakeTimers()
    startupEvent.value = { type: 'ready' }
    const client = new PiRpcClient()
    const starting = client.start({ provider: 'openai', modelId: 'gpt-test', apiKey: 'test-key', accountId: '' })
    await vi.runAllTicks()
    await starting
    await client.abort()
    await vi.advanceTimersByTimeAsync(1_501)
    expect(childKill).toHaveBeenCalledTimes(1)
    await client.stop()
    vi.useRealTimers()
  })

  it('redacts known model credentials from sidecar stderr', async () => {
    startupEvent.value = { type: 'ready' }
    const client = new PiRpcClient()
    await client.start({ provider: 'openai', modelId: 'gpt-test', apiKey: 'model-secret', accountId: '' })
    stderrHandler?.('extension printed model-secret')
    expect(client.getStderr()).toContain('extension printed [REDACTED]')
    expect(client.getStderr()).not.toContain('model-secret')
    await client.stop()
  })
})
