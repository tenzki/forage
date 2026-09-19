import { beforeEach, describe, expect, it, vi } from 'vitest'

const createCommand = vi.hoisted(() => vi.fn())
let stdoutHandler: ((value: string) => void) | undefined
let written: string[] = []

vi.mock('@tauri-apps/api/path', () => ({
  resolveResource: vi.fn(async (resource: string) => `/resources/${resource}`),
}))

vi.mock('@tauri-apps/plugin-shell', () => ({
  Command: {
    create: createCommand.mockImplementation(() => {
      const handlers = new Map<string, (value: unknown) => void>()
      return {
        stdout: { on: (_event: string, handler: (value: string) => void) => { stdoutHandler = handler } },
        stderr: { on: vi.fn() },
        on: (event: string, handler: (value: unknown) => void) => handlers.set(event, handler),
        spawn: async () => {
          queueMicrotask(() => stdoutHandler?.('{"version":1,"kind":"ready"}\n'))
          return { kill: vi.fn(async () => undefined), write: vi.fn(async (line: string) => { written.push(line) }) }
        },
      }
    }),
  },
}))

import { ExtensionManagementClient } from './extensionManagementClient'

beforeEach(() => {
  createCommand.mockClear()
  written = []
  stdoutHandler = undefined
})

describe('ExtensionManagementClient', () => {
  it('starts without model credentials or extension secrets', async () => {
    const client = new ExtensionManagementClient()
    await client.start()
    const options = createCommand.mock.calls[0]![2] as { env: Record<string, string> }
    expect(createCommand.mock.calls[0]![1]).toEqual(['/resources/resources/pi/sidecar/dist/management.mjs'])
    expect(options.env).toEqual({ PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' })
    expect(JSON.stringify(options)).not.toMatch(/API_KEY|access.token|forage-extension\//i)
    await client.stop()
  })

  it('correlates concurrent out-of-order responses and cleans up requests', async () => {
    const client = new ExtensionManagementClient()
    await client.start()
    const inventory = client.request({ operation: 'inventory' })
    const status = client.request({ operation: 'configuration_status', installationId: 'installation-1' })
    const requests = written.map((line) => JSON.parse(line) as { requestId: string; operation: string })
    const second = requests[1]!
    const first = requests[0]!
    stdoutHandler?.(`${JSON.stringify({
      version: 1, kind: 'response', requestId: second.requestId, operation: second.operation, ok: false,
      diagnostics: [{ code: 'not_found', severity: 'error', message: 'Not found.' }],
    })}\n${JSON.stringify({
      version: 1, kind: 'response', requestId: first.requestId, operation: first.operation, ok: true,
      catalog: { version: 1, revision: 'a'.repeat(64), entries: [] },
      configuration: { version: 1, revision: 0, sources: [] },
      extensionsDirectory: '/Users/example/.forage/extensions',
    })}\n`)
    await expect(status).resolves.toMatchObject({ requestId: second.requestId })
    await expect(inventory).resolves.toMatchObject({ requestId: first.requestId })
    await client.stop()
  })

  it('times out bounded requests and rejects malformed protocol output', async () => {
    vi.useFakeTimers()
    const client = new ExtensionManagementClient()
    const starting = client.start()
    await vi.runAllTicks()
    await starting
    const pending = client.request({ operation: 'inventory' }, 10)
    const timedOut = expect(pending).rejects.toThrow(/timed out/i)
    await vi.advanceTimersByTimeAsync(11)
    await timedOut
    vi.useRealTimers()

    const next = client.request({ operation: 'inventory' })
    stdoutHandler?.('extension console noise\n')
    await expect(next).rejects.toThrow(/malformed protocol/i)
    await client.stop()
  })
})
