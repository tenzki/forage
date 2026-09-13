import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { invoke } from '@tauri-apps/api/core'
import { ServerAgentSettings } from './ServerAgentSettings'
import { useSettingsStore } from '../../store/settingsStore'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }))

const timestamp = '2026-08-31T10:00:00.000Z'

describe('server agent settings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useSettingsStore.setState({
      agents: [], skills: [], customTools: [], enabledToolIds: [],
    })
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'server_connection_info') return { origin: 'https://forage.example', instanceId: 'server-1', outlineId: 'outline-1' }
      if (command === 'server_agent_configuration') throw new Error('not published')
      if (command === 'server_agent_runs') return { runs: [{
        id: 'run-1', outlineId: 'outline-1', trigger: 'inbox_automation', status: 'running',
        skillId: 'summarize', policyId: 'youtube-links', configurationRevision: 3,
        attemptCount: 1, admittedAt: timestamp, updatedAt: timestamp, retryOfRunId: null,
      }], nextCursor: null }
      if (command === 'server_agent_run') return {
        id: 'run-1', outlineId: 'outline-1', trigger: 'inbox_automation', status: 'running',
        skillId: 'summarize', policyId: 'youtube-links', configurationRevision: 3,
        attemptCount: 1, admittedAt: timestamp, updatedAt: timestamp, retryOfRunId: null,
        error: null, result: null,
      }
      if (command === 'server_agent_activity') return {
        events: [{ id: 'activity-1', sequence: 1, phase: 'progress', kind: 'tool', label: 'YouTube transcript', status: 'running' }],
        nextCursor: null, status: 'running',
      }
      if (command === 'server_agent_cancel') return { runId: 'run-1', status: 'running' }
      if (command === 'server_agent_automation') return { published: null }
      throw new Error(`unexpected command ${command}`)
    })
  })

  it('shows policy and activity details and exposes durable cancellation', async () => {
    const user = userEvent.setup()
    render(<ServerAgentSettings />)

    await user.click(await screen.findByRole('button', { name: /View \/summarize running/ }))
    expect(await screen.findByText('Policy: youtube-links')).toBeTruthy()
    expect(await screen.findByText('YouTube transcript')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Cancel run' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('server_agent_cancel', { runId: 'run-1' }))
  })

  it('offers published server skills in the Inbox link rules', async () => {
    const fallback = vi.mocked(invoke).getMockImplementation()!
    vi.mocked(invoke).mockImplementation(async (command, arguments_) => {
      if (command === 'server_agent_configuration') return {
        configuration: {
          version: 2, revision: 3, customTools: [], globallyEnabledToolIds: [],
          agents: [{ id: 'agent', name: 'Agent', description: 'Agent', systemPrompt: 'Help.', toolIds: [] }],
          skills: [{ id: 'document-repo', label: 'document-repo', description: 'Document', systemPrompt: 'Document', agentId: 'agent', requiredToolIds: [] }],
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
