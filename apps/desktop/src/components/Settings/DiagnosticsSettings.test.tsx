import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { invoke } from '@tauri-apps/api/core'
import { probeCodexRuntime, probePiRuntime } from '../../agent/piSidecarClient'
import { DiagnosticsSettings, diagnosticVersion } from './DiagnosticsSettings'
import { InheritedCompute } from './InheritedCompute'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('../../agent/piSidecarClient', () => ({ probeCodexRuntime: vi.fn(), probePiRuntime: vi.fn() }))
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(invoke).mockRejectedValue(new Error('api-key=secret-password https://private.example/token'))
  vi.mocked(probePiRuntime).mockResolvedValue({ available: true, version: 'v22.19.0' })
  vi.mocked(probeCodexRuntime).mockResolvedValue({ available: false, error: 'refresh-token=private-token /private/path' })
})
describe('sanitized diagnostics', () => {
  it('shows unchecked rows without claiming readiness or running checks on entry', () => {
    render(<DiagnosticsSettings onConnection={vi.fn()} />)
    expect(screen.getAllByRole('listitem')).toHaveLength(7)
    expect(screen.getByRole('listitem', { name: 'Node.js: not checked' })).toBeTruthy()
    expect(probePiRuntime).not.toHaveBeenCalled()
    expect(probeCodexRuntime).not.toHaveBeenCalled()
    expect((screen.getByRole('button', { name: 'Copy sanitized report' }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('bounds a stalled component without concealing completed results', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(probeCodexRuntime).mockImplementation(() => new Promise(() => undefined))
      const view = render(<DiagnosticsSettings onConnection={vi.fn()} />)
      fireEvent.click(screen.getByRole('button', { name: 'Run checks' }))
      await act(async () => { await vi.advanceTimersByTimeAsync(1) })
      expect(screen.getByRole('listitem', { name: 'Node.js: ready' })).toBeTruthy()
      expect(screen.getByRole('listitem', { name: 'Codex: pending' })).toBeTruthy()
      await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
      expect(screen.getByRole('listitem', { name: 'Codex: unavailable' })).toBeTruthy()
      expect((screen.getByRole('button', { name: 'Run checks' }) as HTMLButtonElement).disabled).toBe(false)
      view.unmount()
    } finally { vi.useRealTimers() }
  })
  it('shows independent results despite failures and copies only whitelisted details', async () => {
    const user = userEvent.setup()
    const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined)
    const onConnection = vi.fn()
    render(<DiagnosticsSettings onConnection={onConnection} />)
    await user.click(screen.getByRole('button', { name: 'Run checks' }))
    expect(await screen.findByRole('listitem', { name: 'Workspace connection: unavailable' })).toBeTruthy()
    expect(screen.getByRole('listitem', { name: 'Node.js: ready' })).toBeTruthy()
    expect(screen.getByRole('listitem', { name: 'Codex: unavailable' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Copy sanitized report' }))
    await waitFor(() => expect(copy).toHaveBeenCalled())
    expect(copy.mock.calls[0]![0]).toContain('v22.19.0')
    expect(copy.mock.calls[0]![0]).not.toMatch(/password|token|private|https:/)
    expect(document.body.textContent).not.toMatch(/password|private-token|private\/path/)
    await user.click(screen.getByRole('button', { name: 'Open Connection settings' }))
    expect(onConnection).toHaveBeenCalledOnce()
  })
  it('rejects secret-bearing runtime versions', () => {
    expect(diagnosticVersion('codex-cli 0.148.0')).toBe('codex-cli 0.148.0')
    expect(diagnosticVersion('22.19.0 sk-private-key')).toBeUndefined()
    expect(diagnosticVersion('22.19.0-sk-private-key')).toBeUndefined()
    expect(diagnosticVersion('/Users/private/node')).toBeUndefined()
  })
  it('never falls back to local compute when the authoritative server fails', async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'event_store_storage_mode') return 'server'
      throw new Error('secret error')
    })
    render(<InheritedCompute />)
    expect(await screen.findByText(/Inherited compute is unavailable/)).toBeTruthy()
    expect(screen.queryByText(/Local ·/)).toBeNull()
    expect(document.body.textContent).not.toContain('secret error')
  })
})
