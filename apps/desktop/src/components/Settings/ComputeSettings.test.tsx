import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { invoke } from '@tauri-apps/api/core'
import { ComputeSettings } from './ComputeSettings'
import { useSettingsStore } from '../../store/settingsStore'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }))

const connection = { origin: 'https://forage.example', instanceId: 'server-1', outlineId: 'outline-1' }
const credential = {
  id: 'credential-1', provider: 'openai', status: 'connected',
  createdAt: '2026-09-02T10:00:00.000Z', updatedAt: '2026-09-02T10:00:00.000Z',
}

function unconnectedInvoke(options: { seedFails?: string } = {}) {
  let enrolled = false
  let provisioning: unknown = null
  vi.mocked(invoke).mockImplementation(async (command, arguments_) => {
    if (command === 'server_connection_info') return enrolled ? connection : null
    if (command === 'server_enroll') { enrolled = true; return undefined }
    if (command === 'event_store_identity') return { outlineId: 'outline-1' }
    if (command === 'event_store_latest_checkpoint') {
      return {
        id: 'c1', outlineId: 'outline-1', documentVersion: 1, schemaEpoch: 1,
        localSequence: 0, serverRevision: 0, createdAt: '', integrityHash: '',
        stateJson: JSON.stringify({ doc: { type: 'doc', content: [] }, trash: [], shortcuts: [], schemaEpoch: 1 }),
      }
    }
    if (command === 'event_store_events_after') return []
    if (command === 'server_seed_outline') {
      if (options.seedFails) throw new Error(options.seedFails)
      return { outlineId: 'outline-1', revision: 0, integrityHash: 'b'.repeat(64) }
    }
    if (command === 'event_store_mark_seeded') return undefined
    if (command === 'event_store_set_storage_mode') return undefined
    if (command === 'server_test_connection') return undefined
    if (command === 'server_agent_enroll_api_key') return credential
    if (command === 'server_agent_publish_configuration') {
      const request = (arguments_ as { request: { configuration: unknown } }).request
      return { configuration: request.configuration, publishedAt: '2026-09-02T10:00:00.000Z' }
    }
    if (command === 'server_agent_publish_compute_profile') {
      const request = (arguments_ as { request: { profile: unknown } }).request
      return { profile: request.profile, credentialStatus: 'connected', updatedAt: '2026-09-02T10:00:00.000Z' }
    }
    if (command === 'server_agent_set_configuration_mirror') return undefined
    if (command === 'server_agent_configuration_mirror') return null
    if (command === 'server_provisioning_state') return provisioning
    if (command === 'server_set_provisioning_state') { provisioning = (arguments_ as { progress: unknown }).progress; return undefined }
    if (command === 'server_agent_configuration') throw new Error('not published')
    throw new Error(`unexpected command ${command}`)
  })
}

describe('compute settings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState({ agents: [], skills: [], customTools: [], enabledToolIds: [], modelId: 'gpt-5.5', isLoaded: true })
  })

  it('preselects local compute and shows no wizard', async () => {
    unconnectedInvoke()
    render(<ComputeSettings />)

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('server_connection_info'))
    expect(screen.getByRole('button', { name: 'Local' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Server' }).getAttribute('aria-pressed')).toBe('false')
    expect(screen.queryByTestId('compute-wizard-progress')).toBeNull()
  })

  it('opens the wizard at step one when server is chosen', async () => {
    unconnectedInvoke()
    const user = userEvent.setup()
    render(<ComputeSettings />)

    await user.click(screen.getByRole('button', { name: 'Server' }))
    expect(screen.getByTestId('compute-wizard-progress').textContent).toContain('Step 1 of 4')
    expect(screen.getByLabelText('Server URL')).toBeTruthy()
  })

  it('syncs portable agent settings during first connection and binds the enrolled credential automatically', async () => {
    useSettingsStore.setState({
      modelId: 'gpt-synced',
      agents: [{ id: 'general', name: 'General', description: 'Agent', systemPrompt: 'Help.', toolIds: ['web_search'] }],
      skills: [{ id: 'ask', label: 'ask', description: 'Ask', systemPrompt: 'Answer.', agentId: 'general', requiredToolIds: [] }],
      customTools: [{ id: 'weather', name: 'Weather', description: 'Forecasts', urlTemplate: 'https://example.com/{{city}}' }],
      enabledToolIds: ['web_search', 'weather'],
    })
    unconnectedInvoke()
    const user = userEvent.setup()
    render(<ComputeSettings />)

    await user.click(screen.getByRole('button', { name: 'Server' }))
    expect(screen.queryByLabelText('Outline ID')).toBeNull()
    await user.type(screen.getByLabelText('Server URL'), 'https://forage.example')
    await user.type(screen.getByLabelText('Device token'), 'device-token')
    await user.click(screen.getByRole('button', { name: 'Connect server' }))

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('server_enroll', {
      origin: 'https://forage.example', deviceToken: 'device-token',
    }))
    expect(screen.getByTestId('compute-wizard-progress').textContent).toContain('Step 2 of 4')

    await user.click(screen.getByRole('button', { name: 'Copy everything to server' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('server_agent_publish_configuration', {
      request: {
        baseRevision: 0,
        configuration: expect.objectContaining({
          revision: 1,
          version: 2,
          agents: [expect.not.objectContaining({ modelId: expect.anything() })],
          skills: [expect.objectContaining({ id: 'ask' })],
          customTools: [expect.objectContaining({ id: 'weather' })],
          globallyEnabledToolIds: ['web_search', 'weather'],
        }),
      },
    }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('event_store_set_storage_mode', { mode: 'server' }))
    expect(screen.getByTestId('compute-wizard-progress').textContent).toContain('Step 3 of 4')

    await user.click(screen.getByRole('button', { name: 'Test connection' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('server_test_connection'))
    await user.click(await screen.findByRole('button', { name: 'Next' }))

    expect(screen.getByTestId('compute-wizard-progress').textContent).toContain('Step 4 of 4')
    await user.type(screen.getByLabelText('Server OpenAI API key'), 'sk-0123456789abcdefghij')
    await user.click(screen.getByRole('button', { name: 'Enroll API key' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('server_agent_enroll_api_key', expect.anything()))

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('server_agent_publish_compute_profile', {
      request: {
        baseRevision: 0,
        profile: expect.objectContaining({ revision: 1, credentialRef: 'credential-1', modelId: 'gpt-synced' }),
      },
    }))
    expect(await screen.findByText(/Server compute is ready/)).toBeTruthy()
  })

  it('returns to local compute when the wizard is cancelled', async () => {
    unconnectedInvoke()
    const user = userEvent.setup()
    render(<ComputeSettings />)

    await user.click(screen.getByRole('button', { name: 'Server' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(screen.getByRole('button', { name: 'Local' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByTestId('compute-wizard-progress')).toBeNull()
  })

  it('shows the summary instead of the wizard for a published server', async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'server_connection_info') return connection
      if (command === 'server_agent_configuration') {
        return {
          configuration: {
            version: 2, revision: 4, skills: [], customTools: [], globallyEnabledToolIds: [],
            agents: [{
              id: 'general', name: 'General', description: 'General assistant', systemPrompt: 'Be useful.',
              toolIds: [],
            }],
          },
          publishedAt: '2026-09-02T10:00:00.000Z',
        }
      }
      if (command === 'server_agent_compute_profile') return {
        profile: { version: 1, revision: 2, provider: 'openai', modelId: 'gpt-5.5', credentialRef: 'credential-1' },
        credentialStatus: 'connected', updatedAt: '2026-09-02T10:00:00.000Z',
      }
      if (command === 'server_agent_credential') return credential
      throw new Error(`unexpected command ${command}`)
    })
    render(<ComputeSettings />)

    expect(await screen.findByText(/Configuration revision: 4/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Server' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByTestId('compute-wizard-progress')).toBeNull()
    expect(screen.getByRole('button', { name: 'Use local compute' })).toBeTruthy()
  })

  it('stays in local mode when the copy step fails', async () => {
    unconnectedInvoke({ seedFails: 'server unavailable' })
    const user = userEvent.setup()
    render(<ComputeSettings />)

    await user.click(screen.getByRole('button', { name: 'Server' }))
    await user.type(screen.getByLabelText('Server URL'), 'https://forage.example')
    await user.type(screen.getByLabelText('Device token'), 'device-token')
    await user.click(screen.getByRole('button', { name: 'Connect server' }))
    await user.click(await screen.findByRole('button', { name: 'Copy everything to server' }))

    expect(await screen.findByText(/server unavailable/)).toBeTruthy()
    expect(invoke).not.toHaveBeenCalledWith('event_store_set_storage_mode', { mode: 'server' })
    expect(screen.getByTestId('compute-wizard-progress').textContent).toContain('Step 2 of 4')
  })

  it('offers the server outline when the server already holds one', async () => {
    unconnectedInvoke({ seedFails: 'This outline has already been seeded.' })
    const user = userEvent.setup()
    render(<ComputeSettings />)

    await user.click(screen.getByRole('button', { name: 'Server' }))
    await user.type(screen.getByLabelText('Server URL'), 'https://forage.example')
    await user.type(screen.getByLabelText('Device token'), 'device-token')
    await user.click(screen.getByRole('button', { name: 'Connect server' }))
    await user.click(await screen.findByRole('button', { name: 'Copy everything to server' }))

    expect(await screen.findByText(/leave this device's local outline behind/)).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Use the server outline' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('server_agent_publish_configuration', {
      request: {
        baseRevision: 0,
        configuration: expect.objectContaining({ revision: 1 }),
      },
    }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('event_store_set_storage_mode', { mode: 'server' }))
  })

  it('does not repair missing configuration opportunistically during settings initialization', async () => {
    vi.mocked(invoke).mockImplementation(async (command, arguments_) => {
      if (command === 'server_connection_info') return connection
      if (command === 'server_agent_configuration') {
        throw new Error('conflict: No server agent configuration has been published.')
      }
      if (command === 'server_agent_publish_configuration') {
        const request = (arguments_ as { request: { configuration: unknown } }).request
        return { configuration: request.configuration, publishedAt: '2026-09-02T10:00:00.000Z' }
      }
      throw new Error(`unexpected command ${command}`)
    })
    render(<ComputeSettings />)

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('server_agent_configuration', undefined))
    expect(invoke).not.toHaveBeenCalledWith('server_agent_publish_configuration', expect.anything())
    expect(await screen.findByText(/Step 2 of 4/)).toBeTruthy()
    expect(screen.getByText(/Copy everything to server/)).toBeTruthy()
  })
})
