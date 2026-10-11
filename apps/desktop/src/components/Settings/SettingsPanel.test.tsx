import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { loginWithChatGpt } from '../../agent/codexAuth'
import { useSettingsStore } from '../../store/settingsStore'
import { SettingsPanel } from './SettingsPanel'
import { openUrl } from '@tauri-apps/plugin-opener'
import { publishLocalAgentConfiguration } from '../../agent/serverConfigurationSync'
import { useExtensionStore } from '../../store/extensionStore'
import { useMcpStore } from '../../store/mcpStore'
import { DEFAULT_DEVICE_PREFERENCES } from '../../store/settingsMigration'

vi.mock('../../applicationMetadata', () => ({ applicationVersion: vi.fn(async () => '3.2.1') }))

vi.mock('../../agent/codexAuth', () => ({
  loginWithChatGpt: vi.fn(),
}))

vi.mock('./ServerAgentSettings', () => ({
  ServerAgentSettings: ({ view }: { view: string }) => <section><h2>{view === 'rules' ? 'Inbox rules' : 'Server recovery'}</h2></section>,
}))

vi.mock('../../agent/serverConfigurationSync', () => ({
  publishLocalAgentConfiguration: vi.fn(async () => 'published'),
}))

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn(async () => undefined),
}))

vi.mock('@tauri-apps/plugin-shell', () => ({
  Command: { create: vi.fn() },
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async (command: string) => command === 'event_store_storage_mode' ? 'local' : null) }))

function resolvedAction() {
  return vi.fn(async () => undefined)
}

function setLoadedSettings() {
  useSettingsStore.setState({
    authMode: 'subscription',
    localCredentials: [],
    modelId: 'gpt-5.5',
    enabledToolIds: ['web_search'],
    customTools: [{
      id: 'weather-tool',
      name: 'weather',
      description: 'Get the current weather',
      urlTemplate: 'https://api.open-meteo.com/v1/forecast?latitude={{latitude}}',
    }],
    agents: [{
      id: 'general-agent',
      name: 'General assistant',
      description: 'General-purpose outline assistant',
      systemPrompt: 'Be useful.',
      toolIds: ['web_search'],
    }],
    skills: [{
      id: 'ask',
      label: 'ask',
      description: 'Ask about this branch',
      systemPrompt: 'Answer the question.',
      agentId: 'general-agent',
      requiredToolIds: [],
    }],
    isLoaded: true,
    error: null,
    devicePreferences: { ...DEFAULT_DEVICE_PREFERENCES },
    preferenceError: null,
    setDevicePreferences: resolvedAction(),
    load: resolvedAction(),
    setAuthMode: resolvedAction(),
    setOpenAiApiKey: resolvedAction(),
    setOAuthCredential: resolvedAction(),
    setModelId: resolvedAction(),
    setToolEnabled: resolvedAction(),
    addCustomTool: resolvedAction(),
    removeCustomTool: resolvedAction(),
    saveAgent: resolvedAction(),
    removeAgent: resolvedAction(),
    saveSkill: resolvedAction(),
    removeSkill: resolvedAction(),
    resetAgentConfiguration: resolvedAction(),
  })
}

describe('settings panel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setLoadedSettings()
    useMcpStore.setState({
      loaded: true, connections: [], serverConnections: [], busy: false, error: null,
      discovery: { candidates: [], warnings: [] }, scanConnections: resolvedAction(),
    })
    useExtensionStore.setState({
      catalog: { version: 1, revision: 'a'.repeat(64), entries: [] },
      configuration: { version: 1, revision: 0, sources: [] },
      extensionsDirectory: '/extensions', isLoaded: true, isLoading: false, error: null,
    })
  })

  it('navigates between focused settings views', async () => {
    const user = userEvent.setup()
    render(<SettingsPanel onBack={vi.fn()} />)

    expect(screen.getByRole('heading', { name: 'General' })).toBeTruthy()
    expect(Array.from(screen.getByRole('navigation', { name: 'Settings sections' }).querySelectorAll('button')).map((button) => button.textContent)).toEqual(['General', 'Connection', 'Agents', 'Extensions', 'MCP servers'])
    expect(await screen.findByText('Forage · Version 3.2.1')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Advanced' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Connection' }))
    expect(screen.getByRole('heading', { name: 'Providers' })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'Default model' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Server agent executor' })).toBeNull()
    expect((screen.getByRole('heading', { name: 'Tools', hidden: true }).closest('section') as HTMLElement).hidden).toBe(true)

    await user.click(screen.getByRole('button', { name: 'Agents' }))
    expect(screen.getByRole('heading', { name: 'Agents' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Skills' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Tools' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Inbox rules' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Server recovery' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Providers' })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Extensions' }))
    expect(screen.getByRole('heading', { name: 'Extensions' })).toBeTruthy()
    expect(screen.getByText(/Trusted local code/i)).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'General' }))
    await user.click(screen.getByRole('button', { name: 'Diagnostics' }))
    expect(screen.getByRole('heading', { name: 'Diagnostics' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'General' }).getAttribute('aria-current')).toBe('page')
    await user.click(screen.getByRole('button', { name: 'Back to General' }))
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Diagnostics' }))
  })

  it('renders only the design back link on extension detail', async () => {
    const user = userEvent.setup()
    useExtensionStore.setState({
      catalog: {
        version: 1, revision: 'a'.repeat(64), entries: [{
          source: { kind: 'local', installationId: 'text-stats', requestedPath: '/extensions/text-stats', canonicalPath: '/extensions/text-stats' },
          manifest: {
            id: 'dev.example.text-stats', name: 'Text Stats', version: '1.0.0',
            description: 'Counts words.', entry: './index.js',
            contributes: { tools: [], hooks: [], settings: [] },
          },
          status: 'disabled', tools: [], diagnostics: [],
        }],
      },
    })
    render(<SettingsPanel onBack={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Extensions' }))
    await user.click(screen.getByRole('button', { name: /Text Stats/ }))
    const back = screen.getAllByRole('button', { name: 'Back to Extensions' })
    expect(back).toHaveLength(1)
    expect(back[0]!.textContent).toBe('←Extensions')
    await user.click(back[0]!)
    expect(screen.getByRole('heading', { name: 'Extensions' })).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Text Stats/ }))
  })

  it.each(['Add provider', 'Manage'])('uses the design Connection back link for %s', async (action) => {
    const user = userEvent.setup()
    useSettingsStore.setState({ localCredentials: [{ id: 'local-openai', provider: 'openai', status: 'connected' }] })
    render(<SettingsPanel onBack={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Connection' }))
    await user.click(await screen.findByRole('button', { name: action }))
    const back = screen.getByRole('button', { name: 'Back to Connection' })
    expect(back.textContent).toBe('←Connection')
    expect(back.classList.contains('settings-back-link')).toBe(true)
    await user.click(back)
    expect(screen.queryByRole('button', { name: 'Back to Connection' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'Providers' })).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: action }))
  })

  it.each(['Add server', 'Manage'])('uses one design MCP back link for %s', async (action) => {
    const user = userEvent.setup()
    useMcpStore.setState({ connections: [{ id: 'pen', name: 'Pen', environment: 'local', enabled: true, tools: [] }] })
    render(<SettingsPanel onBack={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'MCP servers' }))
    await user.click(await screen.findByRole('button', { name: action }))
    const back = screen.getAllByRole('button', { name: 'Back to MCP servers' })
    expect(back).toHaveLength(1)
    expect(back[0]!.textContent).toBe('←MCP servers')
    await user.click(back[0]!)
    expect(screen.queryByRole('button', { name: 'Back to MCP servers' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'MCP servers' })).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: action }))
  })

  it('supports copying, reopening, and cancelling device login', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    vi.mocked(loginWithChatGpt).mockImplementation((onDeviceCode, signal) => {
      onDeviceCode({ userCode: 'ABCD-EFGH', verificationUri: 'https://auth.openai.com/codex/device' })
      return new Promise((_, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('Login cancelled')), { once: true })
      })
    })

    render(<SettingsPanel onBack={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Connection' }))
    await user.click(await screen.findByRole('button', { name: 'Add provider' }))
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'openai-codex' } })
    await user.click(screen.getByRole('button', { name: 'Connect ChatGPT' }))
    expect(await screen.findByText('ABCD-EFGH')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Copy code' }))
    expect(writeText).toHaveBeenCalledWith('ABCD-EFGH')

    await user.click(screen.getByRole('button', { name: 'Open sign-in page' }))
    expect(openUrl).toHaveBeenCalledWith('https://auth.openai.com/codex/device')

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add provider' })).toBeTruthy())
    expect(screen.queryByText('ABCD-EFGH')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Back to Connection' })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Connection' }))
  })

  it('keeps the parent selected and falls back when an edited entity disappears', async () => {
    const user = userEvent.setup()
    render(<SettingsPanel onBack={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Agents' }))
    await user.click(screen.getAllByRole('button', { name: 'Edit' })[0]!)
    expect(screen.getByRole('button', { name: 'Agents' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('button', { name: 'Back to Agents' })).toBeTruthy()
    expect(await screen.findByText(/Local · ChatGPT/)).toBeTruthy()
    expect(screen.queryByRole('combobox', { name: /Model/ })).toBeNull()
    act(() => useSettingsStore.setState({ agents: [] }))
    expect(await screen.findByText(/This saved item is no longer available/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Back to Agents' })).toBeNull()
    expect(screen.queryByRole('group', { name: 'Agent editor' })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Agents' }))
  })

  it('uses a static nested preview and reports automatic-save failures', async () => {
    const user = userEvent.setup()
    render(<SettingsPanel onBack={vi.fn()} />)
    const preview = screen.getByLabelText('Outline appearance preview')
    expect(preview.querySelector('li ul li ul li')).toBeTruthy()
    expect(preview.querySelector('[contenteditable]')).toBeNull()
    expect(screen.queryByText('Run behaviour')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Dark' }))
    expect(useSettingsStore.getState().setDevicePreferences).toHaveBeenCalledWith({ theme: 'dark' })
    act(() => useSettingsStore.setState({ preferenceError: 'Could not save. Retry.' }))
    await user.click(screen.getByRole('button', { name: 'Retry saving appearance' }))
    expect(useSettingsStore.getState().setDevicePreferences).toHaveBeenCalledWith(DEFAULT_DEVICE_PREFERENCES)
  })

  it('uses the Pen General hierarchy and disables theme choices until settings hydrate', async () => {
    const user = userEvent.setup()
    render(<SettingsPanel onBack={vi.fn()} />)
    const theme = screen.getByRole('group', { name: 'Theme' })
    expect(within(theme).getByRole('button', { name: 'System' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByRole('combobox', { name: 'Theme' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'Appearance' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Accessibility' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Support' })).toBeTruthy()
    act(() => useSettingsStore.setState({ isLoaded: false }))
    await user.click(within(theme).getByRole('button', { name: 'Dark' }))
    expect(useSettingsStore.getState().setDevicePreferences).not.toHaveBeenCalled()
  })

  it('places providers and defaults above workspace connection like the Pen screen', async () => {
    const user = userEvent.setup()
    render(<SettingsPanel onBack={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Connection' }))
    const providers = screen.getByRole('heading', { name: 'Providers' })
    const defaults = screen.getByRole('heading', { name: 'Default model' })
    const workspace = await screen.findByRole('heading', { name: 'Workspace connection' })
    expect(providers.compareDocumentPosition(defaults) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(defaults.compareDocumentPosition(workspace) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Connection' }).classList.contains('sr-only')).toBe(true)
  })

  it('guards section changes and Back while an explicit editor has dirty changes', async () => {
    const user = userEvent.setup()
    render(<SettingsPanel onBack={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Agents' }))
    await user.click(screen.getAllByRole('button', { name: 'Edit' })[0]!)
    await user.type(screen.getByLabelText('Agent instructions'), ' Unsaved.')
    await user.click(screen.getByRole('button', { name: 'General' }))
    expect(screen.getByRole('alertdialog', { name: 'Discard unsaved changes?' })).toBeTruthy()
    expect(screen.getByRole('group', { name: 'Agent editor' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Keep editing' }))
    await user.click(screen.getByRole('button', { name: 'Back to Agents' }))
    await user.click(screen.getByRole('button', { name: 'Discard changes' }))
    expect(screen.queryByRole('group', { name: 'Agent editor' })).toBeNull()
    expect(useSettingsStore.getState().saveAgent).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(screen.getAllByRole('button', { name: 'Edit' })[0])
  })

  it('omits removed extension tools from the global tools list', async () => {
    const user = userEvent.setup()
    useSettingsStore.setState({ enabledToolIds: ['web_search', 'generate_image'] })
    render(<SettingsPanel onBack={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Agents' }))
    expect(screen.queryByText('Unavailable references')).toBeNull()
    expect(screen.queryByText('generate_image')).toBeNull()
    expect(screen.getByRole('checkbox', { name: 'Web search' })).toBeTruthy()
  })

  it('requires confirmation before removing a custom tool', async () => {
    const user = userEvent.setup()
    const removeCustomTool = vi.mocked(useSettingsStore.getState().removeCustomTool)
    render(<SettingsPanel onBack={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: 'Agents' }))
    await user.click(screen.getByRole('button', { name: 'Remove weather' }))
    expect(removeCustomTool).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Confirm removing weather' }))
    expect(removeCustomTool).toHaveBeenCalledWith('weather-tool')
  })

  it('requires confirmation for agent, skill, and built-in restoration actions', async () => {
    const user = userEvent.setup()
    const removeAgent = vi.mocked(useSettingsStore.getState().removeAgent)
    const removeSkill = vi.mocked(useSettingsStore.getState().removeSkill)
    const reset = vi.mocked(useSettingsStore.getState().resetAgentConfiguration)
    render(<SettingsPanel onBack={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: 'Agents' }))

    await user.click(screen.getByRole('button', { name: 'Remove General assistant' }))
    expect(removeAgent).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Confirm removing General assistant' }))
    expect(removeAgent).toHaveBeenCalledWith('general-agent')

    await user.click(screen.getByRole('button', { name: 'Remove /ask' }))
    expect(removeSkill).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Confirm removing /ask' }))
    expect(removeSkill).toHaveBeenCalledWith('ask')

    await user.click(screen.getByRole('button', { name: 'Restore built-in agents and skills' }))
    expect(reset).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Confirm restore built-ins' }))
    expect(reset).toHaveBeenCalledOnce()
  })

  it('publishes tool changes to the server agent configuration', async () => {
    const user = userEvent.setup()
    const setToolEnabled = vi.mocked(useSettingsStore.getState().setToolEnabled)
    render(<SettingsPanel onBack={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: 'Agents' }))
    await user.click(screen.getByRole('checkbox', { name: 'Read webpages' }))

    expect(setToolEnabled).toHaveBeenCalledWith('web_fetch', true)
    await waitFor(() => expect(publishLocalAgentConfiguration).toHaveBeenCalledTimes(1))
  })
})
