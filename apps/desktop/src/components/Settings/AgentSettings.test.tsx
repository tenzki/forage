import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useSettingsStore } from '../../store/settingsStore'
import { publishLocalAgentConfiguration } from '../../agent/serverConfigurationSync'
import { AgentSettings } from './AgentSettings'
import type { ExtensionExecutorOption } from '../../store/extensionStore'

vi.mock('../../agent/serverConfigurationSync', () => ({ publishLocalAgentConfiguration: vi.fn(async () => 'local_only') }))

const saveSkill = vi.fn(async (_draft: unknown) => undefined)
const removeSkill = vi.fn(async (_id: string) => undefined)
const executor: ExtensionExecutorOption = {
  extensionId: 'dev.example.notes', executorId: 'label_notes', name: 'Label notes',
  description: 'Labels notes without an LLM.', sourceName: 'Notes', installationId: 'notes-install',
  allowEmptyPrompt: true, available: true,
  configuration: {
    fields: [
      { key: 'contains', label: 'Text to match', type: 'text', required: true, minLength: 1 },
      { key: 'include_ids', label: 'Include IDs', type: 'boolean', default: false },
      { key: 'labels', label: 'Label', type: 'repeat', minimumItems: 1, maximumItems: 2, fields: [{ key: 'name', label: 'Label name', type: 'text', default: 'match' }] },
    ],
    branches: [{ when: { field: 'include_ids', equals: true }, fields: [{ key: 'separator', label: 'Separator', type: 'choice', required: true, options: [{ value: 'dash', label: 'Dash' }] }] }],
  },
}

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

  it('offers extension declarations without creating a skill and saves generic conditional/repeated configuration', async () => {
    const user = userEvent.setup()
    render(<AgentSettings extensionExecutors={[executor]} reportError={vi.fn()} />)
    expect(useSettingsStore.getState().skills).toEqual([])

    await user.click(screen.getByRole('button', { name: /Add skill/ }))
    await user.type(screen.getByLabelText('Slash command'), 'label-notes')
    await user.type(screen.getByLabelText('Skill description'), 'Label matching notes')
    await user.selectOptions(screen.getByLabelText('Skill execution'), 'dev.example.notes/label_notes')
    expect(screen.queryByLabelText('Skill agent')).toBeNull()
    expect(screen.getAllByLabelText('Label name')).toHaveLength(1)
    expect(screen.queryByLabelText('Separator')).toBeNull()
    await user.type(screen.getByLabelText('Text to match'), 'urgent')
    await user.click(screen.getByLabelText('Include IDs'))
    expect((screen.getByLabelText('Separator') as HTMLSelectElement).value).toBe('dash')
    await user.click(screen.getByRole('button', { name: 'Save skill' }))

    expect(saveSkill).toHaveBeenCalledWith(expect.objectContaining({
      execution: 'extension',
      executor: { extensionId: 'dev.example.notes', executorId: 'label_notes' },
      configuration: { contains: 'urgent', include_ids: true, labels: [{ name: 'match' }], separator: 'dash' },
    }))
  })

  it('retains and identifies a missing executor selection and configuration', async () => {
    const user = userEvent.setup()
    useSettingsStore.setState({ skills: [{
      id: 'missing', label: 'missing', description: 'Missing executor', execution: 'extension',
      executor: { extensionId: 'dev.example.missing', executorId: 'classify' }, configuration: { retained: 'yes' },
    }] })
    render(<AgentSettings extensionExecutors={[]} reportError={vi.fn()} />)

    const skills = screen.getByRole('region', { name: 'Skills' })
    await user.click(within(skills).getByRole('button', { name: 'Edit' }))
    expect((screen.getByLabelText('Skill execution') as HTMLSelectElement).value).toBe('dev.example.missing/classify')
    expect((screen.getByRole('option', { name: /unavailable/i }) as HTMLOptionElement).disabled).toBe(true)
    expect(screen.getByRole('alert').textContent).toContain('not installed')
    expect(useSettingsStore.getState().skills[0]).toMatchObject({ configuration: { retained: 'yes' } })
  })

  it('surfaces generic declaration validation before saving an extension skill', async () => {
    const user = userEvent.setup()
    render(<AgentSettings extensionExecutors={[executor]} reportError={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /Add skill/ }))
    await user.type(screen.getByLabelText('Slash command'), 'labels')
    await user.type(screen.getByLabelText('Skill description'), 'Labels')
    await user.selectOptions(screen.getByLabelText('Skill execution'), 'dev.example.notes/label_notes')
    await user.click(screen.getByRole('button', { name: 'Save skill' }))

    expect(screen.getByRole('alert').textContent).toContain('highlighted extension configuration')
    expect(screen.getByText(/field is required/i)).toBeTruthy()
    expect(saveSkill).not.toHaveBeenCalled()
  })

})
