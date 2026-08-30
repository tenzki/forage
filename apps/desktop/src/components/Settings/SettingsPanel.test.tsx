import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { loginWithChatGpt } from '../../agent/codexAuth'
import { useSettingsStore } from '../../store/settingsStore'
import { SettingsPanel } from './SettingsPanel'
import { openUrl } from '@tauri-apps/plugin-opener'

vi.mock('../../agent/codexAuth', () => ({
  loginWithChatGpt: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-shell', () => ({
  Command: { create: vi.fn() },
}))

function resolvedAction() {
  return vi.fn(async () => undefined)
}

function setLoadedSettings() {
  useSettingsStore.setState({
    authMode: 'subscription',
    openAiApiKey: '',
    oauthCredential: null,
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
      modelId: '',
      toolIds: ['web_search'],
    }],
    skills: [{
      id: 'ask',
      label: 'ask',
      description: 'Ask about this branch',
      systemPrompt: 'Answer the question.',
      agentId: 'general-agent',
    }],
    isLoaded: true,
    error: null,
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
  })

  it('navigates between focused settings views', async () => {
    const user = userEvent.setup()
    render(<SettingsPanel onBack={vi.fn()} />)

    expect(screen.getByRole('heading', { name: 'Codex' })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'Default model' }).closest('.model-select')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'ChatGPT subscription' }).getAttribute('aria-pressed')).toBe('true')
    expect((screen.getByRole('heading', { name: 'Tools', hidden: true }).closest('section') as HTMLElement).hidden).toBe(true)

    await user.click(screen.getByRole('button', { name: 'Agents' }))
    expect(screen.getByRole('heading', { name: 'Agents' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Skills' })).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Tools' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Codex' })).toBeNull()

    await user.click(screen.getByRole('button', { name: 'Advanced' }))
    expect(screen.getByRole('heading', { name: 'Agent runtimes' })).toBeTruthy()
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
    await user.click(screen.getByRole('button', { name: 'Connect ChatGPT' }))
    expect(await screen.findByText('ABCD-EFGH')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Copy code' }))
    expect(writeText).toHaveBeenCalledWith('ABCD-EFGH')
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Open browser again' }))
    expect(openUrl).toHaveBeenCalledWith('https://auth.openai.com/codex/device')

    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Connect ChatGPT' })).toBeTruthy())
    expect(screen.queryByText('ABCD-EFGH')).toBeNull()
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
})
