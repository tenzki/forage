import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
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

  it('configures distinct skills and explicit ordering for each link type', async () => {
    useSettingsStore.setState({
      skills: [
        { id: 'transcribe', label: 'transcribe', description: 'Transcript', systemPrompt: 'Transcribe', agentId: 'agent', requiredToolIds: [] },
        { id: 'research', label: 'research', description: 'Research', systemPrompt: 'Research', agentId: 'agent', requiredToolIds: [] },
      ],
    })
    const user = userEvent.setup()
    render(<ServerAgentSettings />)

    await user.selectOptions(await screen.findByRole('combobox', { name: 'Skill for YouTube links' }), 'transcribe')
    await user.selectOptions(screen.getByRole('combobox', { name: 'Skill for Web links' }), 'research')
    await user.click(screen.getByRole('button', { name: 'Move Web links up' }))
    const rows = within(screen.getByTestId('automation-policy-order')).getAllByRole('listitem')
    expect(rows.map((row) => row.textContent?.match(/YouTube|X links|Web links/)?.[0])).toEqual(['YouTube', 'Web links', 'X links'])
  })
})
