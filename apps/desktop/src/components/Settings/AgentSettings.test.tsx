import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useSettingsStore } from '../../store/settingsStore'
import { publishLocalAgentConfiguration } from '../../agent/serverConfigurationSync'
import { AgentSettings } from './AgentSettings'

vi.mock('../../agent/serverConfigurationSync', () => ({ publishLocalAgentConfiguration: vi.fn(async () => 'local_only') }))

const saveSkill = vi.fn(async (_draft: unknown) => undefined)
const removeSkill = vi.fn(async (_id: string) => undefined)

beforeEach(() => {
  saveSkill.mockReset()
  saveSkill.mockResolvedValue(undefined)
  removeSkill.mockClear()
  vi.mocked(publishLocalAgentConfiguration).mockReset()
  vi.mocked(publishLocalAgentConfiguration).mockResolvedValue('local_only')
  useSettingsStore.setState({
    customTools: [],
    agents: [
      { id: 'general-agent', name: 'General assistant', description: 'General', systemPrompt: 'Be useful.', toolIds: ['web_search', 'web_fetch'] },
      { id: 'writer', name: 'Writer', description: 'Writes', systemPrompt: 'Write.', toolIds: [] },
    ],
    skills: [],
    saveSkill,
    removeSkill,
  })
})

async function fillSkill(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /Add skill/ }))
  await user.type(screen.getByLabelText('Slash command'), 'read-link')
  await user.type(screen.getByLabelText('Skill description'), 'Read a link')
  await user.type(screen.getByLabelText('Skill instructions'), 'Read the shared link.')
}

describe('AgentSettings skill form', () => {
  it('shows a failed skill save next to the form instead of only at the bottom of Settings', async () => {
    const user = userEvent.setup()
    const reportError = vi.fn()
    saveSkill.mockRejectedValueOnce(new Error('Slash commands must use 2–32 lowercase letters, numbers, or hyphens.'))
    render(<AgentSettings reportError={reportError} />)
    await fillSkill(user)

    await user.click(screen.getByRole('button', { name: 'Save skill' }))

    const form = screen.getByRole('group', { name: 'Skill editor' })
    expect(within(form).getByRole('alert').textContent).toBe('Slash commands must use 2–32 lowercase letters, numbers, or hyphens.')
    expect(reportError).not.toHaveBeenCalled()
  })

  it('selects required tools from the tools the chosen agent allows', async () => {
    const user = userEvent.setup()
    render(<AgentSettings reportError={vi.fn()} />)
    await fillSkill(user)

    const tools = screen.getByRole('group', { name: 'Required tools' })
    expect(within(tools).getAllByRole('checkbox')).toHaveLength(2)
    await user.click(within(tools).getByRole('checkbox', { name: 'Read webpages' }))
    await user.click(screen.getByRole('button', { name: 'Save skill' }))

    expect(saveSkill).toHaveBeenCalledWith(expect.objectContaining({ label: 'read-link', requiredToolIds: ['web_fetch'] }))
  })

  it('publishes a saved skill to the server so Inbox link rules can use it', async () => {
    const user = userEvent.setup()
    render(<AgentSettings reportError={vi.fn()} />)
    await fillSkill(user)

    await user.click(screen.getByRole('button', { name: 'Save skill' }))

    expect(saveSkill).toHaveBeenCalled()
    expect(publishLocalAgentConfiguration).toHaveBeenCalledTimes(1)
    expect(saveSkill.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(publishLocalAgentConfiguration).mock.invocationCallOrder[0]!)
    expect(screen.queryByRole('group', { name: 'Skill editor' })).toBeNull()
  })

  it('keeps a local save and shows a failed server publish in the Skills section', async () => {
    const user = userEvent.setup()
    vi.mocked(publishLocalAgentConfiguration).mockRejectedValueOnce(new Error('Server unavailable'))
    render(<AgentSettings reportError={vi.fn()} />)
    await fillSkill(user)

    await user.click(screen.getByRole('button', { name: 'Save skill' }))

    expect(screen.queryByRole('group', { name: 'Skill editor' })).toBeNull()
    const skills = screen.getByRole('region', { name: 'Skills' })
    expect(within(skills).getByRole('alert').textContent).toContain('Server unavailable')
  })

  it('publishes after removing a skill', async () => {
    const user = userEvent.setup()
    useSettingsStore.setState({ skills: [{ id: 'old', label: 'old', description: 'Old', systemPrompt: 'Old.', agentId: 'writer', requiredToolIds: [] }] })
    render(<AgentSettings reportError={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: 'Remove /old' }))
    await user.click(screen.getByRole('button', { name: 'Confirm removing /old' }))

    expect(removeSkill).toHaveBeenCalledWith('old')
    expect(publishLocalAgentConfiguration).toHaveBeenCalledTimes(1)
  })

  it('drops required tools the newly chosen agent does not allow', async () => {
    const user = userEvent.setup()
    render(<AgentSettings reportError={vi.fn()} />)
    await fillSkill(user)
    await user.click(within(screen.getByRole('group', { name: 'Required tools' })).getByRole('checkbox', { name: 'Web search' }))

    await user.selectOptions(screen.getByLabelText('Skill agent'), 'Writer')

    expect(within(screen.getByRole('group', { name: 'Required tools' })).queryAllByRole('checkbox')).toHaveLength(0)
    await user.click(screen.getByRole('button', { name: 'Save skill' }))
    expect(saveSkill).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'writer', requiredToolIds: [] }))
  })
})
