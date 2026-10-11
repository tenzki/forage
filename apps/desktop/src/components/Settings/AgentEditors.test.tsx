import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpConnection } from '@forage/agent-runtime'
import { AgentForm, SkillForm, type SelectorTool } from './AgentEditors'
import { useSettingsStore } from '../../store/settingsStore'
import type { AgentDraft, SkillDraft } from '../../agent/definitions'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => 'local') }))
const firstId = `mcp_l_${'a'.repeat(48)}`
const secondId = `mcp_l_${'b'.repeat(48)}`
const connection: McpConnection = { id: 'pen', name: 'Pen', environment: 'local', enabled: true, tools: [
  { id: firstId, remoteName: 'read', name: 'Read design', description: 'Read the current design.', fingerprint: 'a'.repeat(64), inputSchema: { type: 'object' } },
  { id: secondId, remoteName: 'write', name: 'Write design', description: 'Write the current design.', fingerprint: 'b'.repeat(64), inputSchema: { type: 'object' } },
] }
const initial: AgentDraft = { id: 'writer', name: 'Writer', description: 'Write notes.', systemPrompt: 'Write clearly.', toolIds: [] }
const skillTools: SelectorTool[] = [
  { id: 'web_search', name: 'Web search', group: 'Forage', available: true, description: 'Search the web.\n' + 'Detailed instructions. '.repeat(50) },
  { id: 'custom_lookup', name: 'Custom lookup', group: 'Custom HTTP', available: true, description: 'Find a custom record.' },
  { id: 'text_statistics', name: 'Text statistics', group: 'Text Stats · Extension', available: false, description: 'Count words.', unavailableReason: 'Globally disabled.' },
  { id: firstId, name: 'Read design', group: 'MCP', available: true, description: 'Read the current design.' },
  { id: 'disabled_lookup', name: 'Disabled lookup', group: 'Custom HTTP', available: false, description: 'Look up disabled records.', unavailableReason: 'Globally disabled.' },
]
const skillAgent = { ...initial, id: 'writer', toolIds: skillTools.map((tool) => tool.id) }
const initialSkill: SkillDraft = { id: 'summarize', label: 'summarize', description: 'Summarize notes.', execution: 'llm', agentId: skillAgent.id, systemPrompt: 'Summarize this branch.', requiredToolIds: ['text_statistics'] }
beforeEach(() => useSettingsStore.setState({ enabledToolIds: [firstId, secondId], agents: [{ ...initial, id: 'other', toolIds: [firstId] }], isLoaded: true }))
describe('compact skill editing', () => {
  it('collapses descriptions from every tool source without changing the draft or dirtying cancellation', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn(async () => undefined)
    const onCancel = vi.fn()
    render(<SkillForm initial={initialSkill} agents={[skillAgent]} tools={skillTools} executors={[]} onSave={onSave} onCancel={onCancel} />)
    expect(screen.getByLabelText('Slash command').parentElement!.className).toBe('settings-editable-field')
    expect(screen.getByLabelText('Skill description').parentElement!.className).toBe('settings-editable-field')
    const required = screen.getByRole('group', { name: 'Required tools' })
    expect(required.classList.contains('settings-agent-tools')).toBe(true)
    for (const tool of skillTools) {
      const expand = within(required).getByRole('button', { name: `Expand ${tool.name} description` })
      const description = document.getElementById(expand.getAttribute('aria-controls')!)!
      expect(description.hidden).toBe(true)
      expand.focus()
      await user.keyboard('{Enter}')
      expect(description.hidden).toBe(false)
      expect(within(required).getByRole('button', { name: `Collapse ${tool.name} description` }).getAttribute('aria-expanded')).toBe('true')
      expect((within(required).getByRole('checkbox', { name: tool.name }) as HTMLInputElement).checked).toBe(tool.id === 'text_statistics')
      await user.click(within(required).getByRole('button', { name: `Collapse ${tool.name} description` }))
      expect(description.hidden).toBe(true)
    }
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('retains unavailable requirements on save and permits removal without granting disabled tools', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn(async () => undefined)
    render(<SkillForm initial={initialSkill} agents={[skillAgent]} tools={skillTools} executors={[]} onSave={onSave} onCancel={vi.fn()} />)
    expect(screen.getAllByText('Unavailable: Globally disabled.')).toHaveLength(2)
    expect((screen.getByRole('checkbox', { name: 'Disabled lookup' }) as HTMLInputElement).disabled).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Save skill' }))
    expect(onSave).toHaveBeenLastCalledWith(initialSkill)
    await user.click(screen.getByRole('checkbox', { name: 'Text statistics' }))
    expect((screen.getByRole('checkbox', { name: 'Text statistics' }) as HTMLInputElement).disabled).toBe(true)
    await user.click(screen.getByRole('checkbox', { name: 'Web search' }))
    await user.click(screen.getByRole('button', { name: 'Save skill' }))
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ requiredToolIds: ['web_search'] }))
  })
})

describe('explicit agent editing and MCP review', () => {
  it('keeps ordinary tool descriptions collapsed and disclosure separate from permission changes', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn(async () => undefined)
    const tools: SelectorTool[] = [
      { id: 'web_search', name: 'Web search', group: 'Forage', available: true, description: 'Search the web.\n' + 'Detailed instructions. '.repeat(50) },
      { id: 'text_statistics', name: 'Text statistics', group: 'Text Stats · Extension', available: false, description: 'Count words.', unavailableReason: 'Globally disabled.' },
    ]
    render(<AgentForm initial={initial} tools={tools} connections={[]} onSave={onSave} onCancel={vi.fn()} />)
    expect(screen.getByText('Name')).toBeTruthy()
    const expand = screen.getByRole('button', { name: 'Expand Web search description' })
    const description = document.getElementById(expand.getAttribute('aria-controls')!)!
    expect(description.hidden).toBe(true)
    expect(screen.getByText('Unavailable: Globally disabled.')).toBeTruthy()
    expect((screen.getByRole('checkbox', { name: 'Text statistics' }) as HTMLInputElement).disabled).toBe(true)
    expand.focus()
    await user.keyboard('{Enter}')
    expect(description.hidden).toBe(false)
    expect(screen.getByRole('button', { name: 'Collapse Web search description' }).getAttribute('aria-expanded')).toBe('true')
    expect((screen.getByRole('checkbox', { name: 'Web search' }) as HTMLInputElement).checked).toBe(false)
    await user.click(screen.getByRole('button', { name: 'Collapse Web search description' }))
    expect(description.hidden).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Save agent' }))
    expect(onSave).toHaveBeenCalledWith(initial)
  })

  it('keeps MCP tool descriptions collapsed while preserving explicit tool selection', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn(async () => undefined)
    render(<AgentForm initial={initial} tools={[]} connections={[connection]} onSave={onSave} onCancel={vi.fn()} />)
    expect(screen.getByRole('group', { name: 'Tools' }).contains(screen.getByRole('region', { name: 'MCP server access' }))).toBe(true)
    const choose = screen.getByRole('button', { name: 'Choose tools for Pen' })
    expect(choose.parentElement!.firstElementChild).toBe(choose)
    choose.focus()
    await user.tab()
    expect(document.activeElement).toBe(screen.getByRole('checkbox', { name: 'Pen' }))
    await user.click(screen.getByRole('button', { name: 'Choose tools for Pen' }))
    const expand = screen.getByRole('button', { name: 'Expand Read design description' })
    const description = document.getElementById(expand.getAttribute('aria-controls')!)!
    expect(description.hidden).toBe(true)
    await user.click(expand)
    expect(description.hidden).toBe(false)
    expect((screen.getByRole('checkbox', { name: 'Read design' }) as HTMLInputElement).checked).toBe(false)
    await user.click(screen.getByRole('checkbox', { name: 'Read design' }))
    await user.click(screen.getByRole('button', { name: 'Use selected tools' }))
    await user.click(screen.getByRole('button', { name: 'Save agent' }))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ toolIds: [firstId] }))
  })

  it('retains failed-save drafts and confirms dirty cancellation without changing saved or admitted configuration', async () => {
    const user = userEvent.setup()
    const saved = structuredClone(useSettingsStore.getState().agents)
    const admitted = structuredClone(initial)
    const onSave = vi.fn(async () => { throw new Error('Name validation failed.') })
    const onCancel = vi.fn()
    render(<AgentForm initial={initial} tools={[]} connections={[]} onSave={onSave} onCancel={onCancel} />)
    await user.type(screen.getByLabelText('Agent instructions'), ' More details.')
    await user.click(screen.getByRole('button', { name: 'Save agent' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Name validation failed.')
    expect((screen.getByLabelText('Agent instructions') as HTMLTextAreaElement).value).toContain('More details.')
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await user.click(screen.getByRole('button', { name: 'Keep editing' }))
    expect(onCancel).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await user.click(screen.getByRole('button', { name: 'Discard changes' }))
    expect(onCancel).toHaveBeenCalledOnce()
    expect(useSettingsStore.getState().agents).toEqual(saved)
    expect(admitted.systemPrompt).toBe('Write clearly.')
  })
  it('requires explicit individual-tool review and grants nothing on review cancellation', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn(async () => undefined)
    render(<AgentForm initial={initial} tools={[]} connections={[connection]} onSave={onSave} onCancel={vi.fn()} />)
    expect(screen.queryByRole('checkbox', { name: 'Allow MCP tools' })).toBeNull()
    await user.click(screen.getByRole('checkbox', { name: 'Pen' }))
    expect((screen.getByRole('checkbox', { name: 'Read design' }) as HTMLInputElement).checked).toBe(false)
    await user.click(screen.getByRole('checkbox', { name: 'Read design' }))
    await user.click(screen.getByRole('button', { name: 'Cancel tool review' }))
    expect(screen.getByText('MCP server · 0 of 2 tools selected')).toBeTruthy()
    expect(onSave).not.toHaveBeenCalled()
    await user.click(screen.getByRole('checkbox', { name: 'Pen' }))
    await user.click(screen.getByRole('checkbox', { name: 'Read design' }))
    await user.click(screen.getByRole('button', { name: 'Use selected tools' }))
    await user.click(screen.getByRole('button', { name: 'Save agent' }))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ toolIds: [firstId] }))
    expect(useSettingsStore.getState().agents[0]!.toolIds).toEqual([firstId])
    expect(useSettingsStore.getState().enabledToolIds).toEqual([firstId, secondId])
  })
  it('disables only this agent’s server grants and preserves unrelated references', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn(async () => undefined)
    render(<AgentForm initial={{ ...initial, toolIds: [firstId, 'missing_tool'] }} tools={[]} connections={[connection]} onSave={onSave} onCancel={vi.fn()} />)
    await user.click(screen.getByRole('checkbox', { name: 'Pen' }))
    await user.click(screen.getByRole('button', { name: 'Save agent' }))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ toolIds: ['missing_tool'] }))
    expect(useSettingsStore.getState().agents[0]!.toolIds).toEqual([firstId])
    expect(connection.enabled).toBe(true)
  })
  it('invalidates changed inventory during and after review and never grants new tools implicitly', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn(async () => undefined)
    const view = render(<AgentForm initial={initial} tools={[]} connections={[connection]} onSave={onSave} onCancel={vi.fn()} />)
    await user.click(screen.getByRole('checkbox', { name: 'Pen' }))
    await user.click(screen.getByRole('checkbox', { name: 'Read design' }))
    const changed = { ...connection, tools: connection.tools.map((tool) => ({ ...tool, remoteName: `${tool.remoteName}_replacement` })) }
    view.rerender(<AgentForm initial={initial} tools={[]} connections={[changed]} onSave={onSave} onCancel={vi.fn()} />)
    expect(screen.getByRole('alert').textContent).toContain('changed during review')
    expect((screen.getByRole('button', { name: 'Use selected tools' }) as HTMLButtonElement).disabled).toBe(true)
    await user.click(screen.getByRole('button', { name: 'Cancel tool review' }))
    await user.click(screen.getByRole('button', { name: 'Choose tools for Pen' }))
    await user.click(screen.getByRole('checkbox', { name: 'Read design' }))
    await user.click(screen.getByRole('button', { name: 'Use selected tools' }))
    view.rerender(<AgentForm initial={initial} tools={[]} connections={[connection]} onSave={onSave} onCancel={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Save agent' }))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'MCP tools changed or are globally disabled. Review Choose tools again before saving.')
    expect(onSave).not.toHaveBeenCalled()
  })
  it('cannot authorize globally disabled tools from the agent picker', async () => {
    const user = userEvent.setup()
    act(() => useSettingsStore.setState({ enabledToolIds: [] }))
    render(<AgentForm initial={initial} tools={[]} connections={[connection]} onSave={vi.fn()} onCancel={vi.fn()} />)
    await user.click(screen.getByRole('checkbox', { name: 'Pen' }))
    const review = screen.getByRole('group', { name: 'Choose tools for Pen' })
    expect((within(review).getByRole('checkbox', { name: 'Read design' }) as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Use selected tools' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('retains an agent tool selection across definition updates without another review', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn(async () => undefined)
    const view = render(<AgentForm initial={initial} tools={[]} connections={[connection]} onSave={onSave} onCancel={vi.fn()} />)
    await user.click(screen.getByRole('checkbox', { name: 'Pen' }))
    await user.click(screen.getByRole('checkbox', { name: 'Read design' }))
    await user.click(screen.getByRole('button', { name: 'Use selected tools' }))
    const changed = { ...connection, tools: connection.tools.map((tool) => ({ ...tool, description: 'Updated definition', fingerprint: 'c'.repeat(64) })) }
    view.rerender(<AgentForm initial={initial} tools={[]} connections={[changed]} onSave={onSave} onCancel={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Save agent' }))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ toolIds: [firstId] }))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
