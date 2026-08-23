import { describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/api/path', () => ({
  appDataDir: vi.fn(),
  resolveResource: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-shell', () => ({
  Command: {
    create: vi.fn((name: string) => {
      const handlers = new Map<string, (value: unknown) => void>()
      let stdout: ((value: string) => void) | undefined
      return {
        stdout: { on: (_event: string, handler: (value: string) => void) => { stdout = handler } },
        stderr: { on: vi.fn() },
        on: (event: string, handler: (value: unknown) => void) => { handlers.set(event, handler) },
        spawn: async () => {
          stdout?.(name === 'codex-version' ? 'codex-cli 0.148.0\n' : '0.84.2\n')
          handlers.get('close')?.({ code: 0, signal: null })
          return { kill: vi.fn(), write: vi.fn() }
        },
      }
    }),
  },
}))

import { probeCodexRuntime, probePiRuntime } from './piRpcClient'

describe('Pi runtime diagnostics', () => {
  it('reports the installed Pi and Codex versions', async () => {
    await expect(probePiRuntime()).resolves.toEqual({ available: true, version: '0.84.2' })
    await expect(probeCodexRuntime()).resolves.toEqual({ available: true, version: 'codex-cli 0.148.0' })
  })
})
