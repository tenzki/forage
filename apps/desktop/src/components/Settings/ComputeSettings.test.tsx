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

function unconnectedInvoke() {
  let enrolled = false
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === 'server_connection_info') return enrolled ? connection : null
    if (command === 'server_enroll') { enrolled = true; return undefined }
    if (command === 'server_test_connection') return undefined
    if (command === 'server_agent_enroll_api_key') return credential
    if (command === 'server_agent_publish_configuration') {
      return { configuration: { version: 1, revision: 1, agents: [], skills: [], customTools: [], globallyEnabledToolIds: [] }, publishedAt: '2026-09-02T10:00:00.000Z' }
    }
    if (command === 'server_agent_configuration') throw new Error('not published')
    throw new Error(`unexpected command ${command}`)
  })
}

describe('compute settings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState({ agents: [], skills: [], customTools: [], enabledToolIds: [] })
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

  it('walks connect, verify, credential, and publish', async () => {
    unconnectedInvoke()
    const user = userEvent.setup()
    render(<ComputeSettings />)

    await user.click(screen.getByRole('button', { name: 'Server' }))
    await user.type(screen.getByLabelText('Server URL'), 'https://forage.example')
    await user.type(screen.getByLabelText('Outline ID'), 'outline-1')
    await user.type(screen.getByLabelText('Device token'), 'device-token')
    await user.click(screen.getByRole('button', { name: 'Connect server' }))

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('server_enroll', {
      origin: 'https://forage.example', outlineId: 'outline-1', deviceToken: 'device-token',
    }))
    expect(screen.getByTestId('compute-wizard-progress').textContent).toContain('Step 2 of 4')

    await user.click(screen.getByRole('button', { name: 'Test connection' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('server_test_connection'))
    await user.click(await screen.findByRole('button', { name: 'Next' }))

    expect(screen.getByTestId('compute-wizard-progress').textContent).toContain('Step 3 of 4')
    await user.type(screen.getByLabelText('Server OpenAI API key'), 'sk-0123456789abcdefghij')
    await user.click(screen.getByRole('button', { name: 'Enroll API key' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('server_agent_enroll_api_key', expect.anything()))

    await user.click(await screen.findByRole('button', { name: 'Next' }))
    expect(screen.getByTestId('compute-wizard-progress').textContent).toContain('Step 4 of 4')
    await user.click(screen.getByRole('button', { name: 'Publish agents and skills' }))

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('server_agent_publish_configuration', expect.anything()))
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
            version: 1, revision: 4, skills: [], customTools: [], globallyEnabledToolIds: [],
            agents: [{
              id: 'general', name: 'General', description: 'General assistant', systemPrompt: 'Be useful.',
              modelId: '', toolIds: [], credentialRef: 'credential-1',
            }],
          },
          publishedAt: '2026-09-02T10:00:00.000Z',
        }
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
})
