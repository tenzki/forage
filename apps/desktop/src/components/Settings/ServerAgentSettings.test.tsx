import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { invoke } from '@tauri-apps/api/core'
import { ServerAgentSettings } from './ServerAgentSettings'
import { useSettingsStore } from '../../store/settingsStore'
import { usePublishedServerConfiguration } from '../../agent/serverConfigurationSync'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }))

const timestamp = '2026-08-31T10:00:00.000Z'

describe('server agent settings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    usePublishedServerConfiguration.setState({ configuration: null })
    useSettingsStore.setState({
      agents: [], skills: [], customTools: [], enabledToolIds: [],
    })
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'server_connection_info') return { origin: 'https://forage.example', instanceId: 'server-1', outlineId: 'outline-1' }
      if (command === 'server_agent_configuration') throw new Error('not published')
      if (command === 'server_agent_automation') return { published: null }
      throw new Error(`unexpected command ${command}`)
    })
  })

  it('leaves run history to the activity sidebar', async () => {
    render(<ServerAgentSettings />)

    expect(await screen.findByRole('heading', { name: 'Server agent executor' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Recent runs' })).toBeNull()
  })

  it('offers skills published from elsewhere in Settings without reopening it', async () => {
    const user = userEvent.setup()
    render(<ServerAgentSettings />)
    await user.click(await screen.findByRole('button', { name: 'Edit GitHub' }))
    expect(screen.getByText('Publish agents and skills first.')).toBeTruthy()

    act(() => usePublishedServerConfiguration.getState().accept({
      version: 3, revision: 4, customTools: [], globallyEnabledToolIds: [],
      agents: [{ id: 'agent', name: 'Agent', description: 'Agent', systemPrompt: 'Help.', toolIds: [] }],
      skills: [{ id: 'research-inbox', execution: 'llm', label: 'research-inbox', description: 'Inbox', systemPrompt: 'Read.', agentId: 'agent', requiredToolIds: [] }],
    }))

    await user.click(screen.getByRole('combobox', { name: 'Add skill to GitHub' }))
    expect(screen.getByRole('option', { name: '/research-inbox' })).toBeTruthy()
  })

  it('offers published server skills in the Inbox link rules', async () => {
    const fallback = vi.mocked(invoke).getMockImplementation()!
    vi.mocked(invoke).mockImplementation(async (command, arguments_) => {
      if (command === 'server_agent_configuration') return {
        configuration: {
          version: 3, revision: 3, customTools: [], globallyEnabledToolIds: [],
          agents: [{ id: 'agent', name: 'Agent', description: 'Agent', systemPrompt: 'Help.', toolIds: [] }],
          skills: [{ id: 'document-repo', execution: 'llm', label: 'document-repo', description: 'Document', systemPrompt: 'Document', agentId: 'agent', requiredToolIds: [] }],
        },
        publishedAt: timestamp,
      }
      if (command === 'server_agent_compute_profile') throw new Error('not configured')
      if (command === 'server_agent_automation') return { published: null }
      return fallback(command, arguments_)
    })
    const user = userEvent.setup()
    render(<ServerAgentSettings />)

    await user.click(await screen.findByRole('button', { name: 'Edit GitHub' }))
    await user.click(screen.getByRole('combobox', { name: 'Add skill to GitHub' }))
    expect(screen.getByRole('option', { name: '/document-repo' })).toBeTruthy()
    await waitFor(() => expect((screen.getByRole('button', { name: 'Publish link rules' }) as HTMLButtonElement).disabled).toBe(false))
    expect(screen.queryByRole('combobox', { name: /Skill for/ })).toBeNull()
  })
})
