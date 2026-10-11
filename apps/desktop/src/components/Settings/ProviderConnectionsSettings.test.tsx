import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useSettingsStore } from '../../store/settingsStore'
import { TauriServerAgentTransport } from '../../agent/serverExecutor'
import { ProviderConnectionsSettings } from './ProviderConnectionsSettings'

const fixture = vi.hoisted(() => ({ mode: 'local', invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: fixture.invoke }))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }))
const initial = useSettingsStore.getState()

beforeEach(() => {
  vi.clearAllMocks()
  fixture.mode = 'local'
  fixture.invoke.mockImplementation(async (command: string) => {
    if (command === 'event_store_storage_mode') return fixture.mode
    throw new Error('Server unavailable')
  })
  useSettingsStore.setState({ ...initial, isLoaded: true, localCredentials: [{ id: 'local-openai', provider: 'openai', status: 'connected' }], localCompute: { provider: 'openai', modelId: 'gpt-5', credentialRef: 'local-openai' }, connectApiKey: vi.fn(async () => {}), selectLocalCompute: vi.fn(async () => {}) })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); useSettingsStore.setState(initial, true) })

describe('provider connections', () => {
  it('uses a dedicated provider setup heading and divided connection fields', async () => {
    const user = userEvent.setup()
    render(<ProviderConnectionsSettings />)
    await user.click(await screen.findByRole('button', { name: 'Add provider' }))
    expect(screen.getByRole('heading', { name: 'Add provider' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Providers' })).toBeNull()
    await user.selectOptions(screen.getByLabelText('Provider'), 'openai')
    expect(screen.getByRole('heading', { name: 'Connect OpenAI' }).closest('.settings-divider')).toBeTruthy()
    expect(screen.getByLabelText('API key').closest('.auth-card')).toBeNull()
    expect(screen.getByRole('button', { name: 'Connect provider' }).parentElement).toBe(screen.getByRole('button', { name: 'Cancel' }).parentElement)
    expect(useSettingsStore.getState().connectApiKey).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.getByRole('heading', { name: 'Providers' })).toBeTruthy()
  })
  it('shows saved defaults in the paired controls without implicitly saving them', async () => {
    render(<ProviderConnectionsSettings />)
    await screen.findByRole('button', { name: 'Manage' })
    expect((screen.getByRole('combobox', { name: 'Default provider' }) as HTMLSelectElement).value).toBe('openai')
    expect((screen.getByRole('combobox', { name: 'Default model' }) as HTMLSelectElement).value).toBe('gpt-5')
    expect((screen.getByRole('button', { name: 'Save defaults' }) as HTMLButtonElement).disabled).toBe(true)
    expect(useSettingsStore.getState().selectLocalCompute).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole('combobox', { name: 'Default model' }), { target: { value: 'gpt-5.5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save defaults' }))
    await waitFor(() => expect(useSettingsStore.getState().selectLocalCompute).toHaveBeenCalledWith({ provider: 'openai', modelId: 'gpt-5.5', credentialRef: 'local-openai' }))
  })
  it('cancels setup without saving a key or changing defaults', async () => {
    const user = userEvent.setup()
    render(<ProviderConnectionsSettings />)
    await user.click(await screen.findByRole('button', { name: 'Add provider' }))
    await user.type(screen.getByLabelText('API key'), 'private-key')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByLabelText('API key')).toBeNull()
    expect(useSettingsStore.getState().connectApiKey).not.toHaveBeenCalled()
    expect(useSettingsStore.getState().selectLocalCompute).not.toHaveBeenCalled()
  })

  it('clears failed keys and keeps the saved default unchanged', async () => {
    const user = userEvent.setup()
    useSettingsStore.setState({ connectApiKey: vi.fn(async () => { throw new Error('private-key') }) })
    render(<ProviderConnectionsSettings />)
    await user.click(await screen.findByRole('button', { name: 'Add provider' }))
    await user.type(screen.getByLabelText('API key'), 'private-key')
    await user.click(screen.getByRole('button', { name: 'Connect provider' }))
    expect(await screen.findByRole('alert')).not.toHaveProperty('textContent', expect.stringContaining('private-key'))
    expect((screen.getByLabelText('API key') as HTMLInputElement).value).toBe('')
    expect(useSettingsStore.getState().localCompute.modelId).toBe('gpt-5')
  })

  it('aborts in-flight setup on cancel without admitting an account', async () => {
    const user = userEvent.setup()
    let signal: AbortSignal | undefined
    useSettingsStore.setState({ connectApiKey: vi.fn(async (_provider, _key, abortSignal) => {
      signal = abortSignal
      await new Promise<void>((_resolve, reject) => abortSignal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true }))
    }) })
    render(<ProviderConnectionsSettings />)
    await user.click(await screen.findByRole('button', { name: 'Add provider' }))
    await user.type(screen.getByLabelText('API key'), 'private-key')
    await user.click(screen.getByRole('button', { name: 'Connect provider' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(signal?.aborted).toBe(true)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add provider' }).hasAttribute('disabled')).toBe(false))
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('retains a repairable default after disconnect', async () => {
    const user = userEvent.setup()
    useSettingsStore.setState({ disconnectAccount: vi.fn(async () => { useSettingsStore.setState({ localCredentials: [] }) }) })
    render(<ProviderConnectionsSettings />)
    await user.click(await screen.findByRole('button', { name: 'Manage' }))
    await user.click(screen.getByRole('button', { name: 'Disconnect' }))
    await user.click(screen.getByRole('button', { name: 'Confirm disconnect' }))
    expect(await screen.findByText(/default account is unavailable/)).toBeTruthy()
    expect(useSettingsStore.getState().localCompute.credentialRef).toBe('local-openai')
  })

  it('saves provider, model and reference together only after explicit selection', async () => {
    render(<ProviderConnectionsSettings />)
    await screen.findByRole('button', { name: 'Add provider' })
    fireEvent.change(screen.getByLabelText('Default provider'), { target: { value: 'openai' } })
    expect((screen.getByLabelText('Default model') as HTMLSelectElement).value).toBe('')
    expect(useSettingsStore.getState().selectLocalCompute).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText('Default model'), { target: { value: 'gpt-5' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save defaults' }))
    await waitFor(() => expect(useSettingsStore.getState().selectLocalCompute).toHaveBeenCalledWith({ provider: 'openai', modelId: 'gpt-5', credentialRef: 'local-openai' }))
  })

  it('does not expose local accounts or permit new writes on older servers', async () => {
    fixture.mode = 'server'
    vi.spyOn(TauriServerAgentTransport.prototype, 'readiness').mockResolvedValue({} as Awaited<ReturnType<TauriServerAgentTransport['readiness']>>)
    vi.spyOn(TauriServerAgentTransport.prototype, 'computeProfile').mockRejectedValue(new Error('Not configured'))
    render(<ProviderConnectionsSettings />)
    expect(await screen.findByText(/requires a newer server/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Manage' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Add provider' }).hasAttribute('disabled')).toBe(true)
    expect(useSettingsStore.getState().localCredentials).toHaveLength(1)
  })

  it('never falls back to device accounts when the server fails', async () => {
    fixture.mode = 'server'
    vi.spyOn(TauriServerAgentTransport.prototype, 'readiness').mockRejectedValue(new Error('private-key'))
    render(<ProviderConnectionsSettings />)
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Manage' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Add provider' }).hasAttribute('disabled')).toBe(true)
  })

  it('keeps server drafts separate from active compute on a revision conflict', async () => {
    fixture.mode = 'server'
    vi.spyOn(TauriServerAgentTransport.prototype, 'readiness').mockResolvedValue({ supportedProviders: [{ provider: 'anthropic', authentication: 'api_key', modelIds: ['claude-old', 'claude-new'] }] } as Awaited<ReturnType<TauriServerAgentTransport['readiness']>>)
    vi.spyOn(TauriServerAgentTransport.prototype, 'accounts').mockResolvedValue([{ id: 'server-anthropic', provider: 'anthropic', status: 'connected', createdAt: '2026-09-29T10:00:00.000Z', updatedAt: '2026-09-29T10:00:00.000Z' }])
    vi.spyOn(TauriServerAgentTransport.prototype, 'computeProfile').mockResolvedValue({ profile: { version: 1, revision: 3, provider: 'anthropic', modelId: 'claude-old', credentialRef: 'server-anthropic' }, credentialStatus: 'connected', updatedAt: '2026-09-29T10:00:00.000Z' })
    const publish = vi.spyOn(TauriServerAgentTransport.prototype, 'publishComputeProfile').mockRejectedValue(new Error('Revision conflict'))
    render(<ProviderConnectionsSettings />)
    await screen.findByRole('button', { name: 'Manage' })
    expect(screen.getByText(/Current: Anthropic \/ claude-old/)).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Default provider'), { target: { value: 'anthropic' } })
    fireEvent.change(screen.getByLabelText('Default model'), { target: { value: 'claude-new' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save defaults' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(publish).toHaveBeenCalledWith({ baseRevision: 3, profile: { version: 1, revision: 4, provider: 'anthropic', modelId: 'claude-new', credentialRef: 'server-anthropic' } })
    expect(screen.getByText(/Current: Anthropic \/ claude-old/)).toBeTruthy()
    expect((screen.getByLabelText('Default model') as HTMLSelectElement).value).toBe('claude-new')
    expect(useSettingsStore.getState().selectLocalCompute).not.toHaveBeenCalled()
    expect(useSettingsStore.getState().localCompute.provider).toBe('openai')
  })

  it('returns to the retained local account inventory after disconnecting the workspace', async () => {
    fixture.mode = 'server'
    vi.spyOn(TauriServerAgentTransport.prototype, 'readiness').mockRejectedValue(new Error('Unavailable'))
    const view = render(<ProviderConnectionsSettings environmentRevision={0} />)
    await screen.findByRole('alert')
    fixture.mode = 'local'
    view.rerender(<ProviderConnectionsSettings environmentRevision={1} />)
    expect(await screen.findByRole('button', { name: 'Manage' })).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText(/Current: OpenAI \/ gpt-5/)).toBeTruthy()
  })
})
