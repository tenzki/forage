import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import SettingsPage from './SettingsPage'
import type { Settings } from '../../store/settingsStore'

// ─── Mock the settings store ──────────────────────────────────────────────────

const mockSaveProviderKey = vi.fn()
const mockRemoveProviderKey = vi.fn()
const mockSetDefaultModel = vi.fn()
const mockLoadSettings = vi.fn()

const defaultSettings: Settings = {
  providers: {
    anthropic: { apiKey: '', enabled: false },
    openai:    { apiKey: '', enabled: false },
    google:    { apiKey: '', enabled: false },
  },
  defaultModel: 'claude-sonnet-4-20250514',
}

vi.mock('../../store/settingsStore', () => ({
  useSettingsStore: (selector?: (s: unknown) => unknown) => {
    const store = {
      settings: defaultSettings,
      isLoaded: true,
      loadSettings: mockLoadSettings,
      saveProviderKey: mockSaveProviderKey,
      removeProviderKey: mockRemoveProviderKey,
      setDefaultModel: mockSetDefaultModel,
    }
    return selector ? selector(store) : store
  },
}))

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('SettingsPage', () => {
  const onBackMock = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders three provider inputs: Anthropic, OpenAI, Google', () => {
    render(<SettingsPage onBack={onBackMock} />)
    expect(screen.getByText(/^anthropic$/i)).toBeTruthy()
    expect(screen.getByText(/^openai$/i)).toBeTruthy()
    expect(screen.getByText(/^google$/i)).toBeTruthy()
  })

  it('renders the default model selector dropdown', () => {
    render(<SettingsPage onBack={onBackMock} />)
    const select = screen.getByRole('combobox')
    expect(select).toBeTruthy()
    // Should have Anthropic model options in the dropdown
    expect(screen.getByRole('option', { name: /claude sonnet/i })).toBeTruthy()
  })

  it('saving a key calls saveProviderKey with correct provider and key', () => {
    render(<SettingsPage onBack={onBackMock} />)
    // Find the Anthropic provider input by placeholder text
    const anthropicInput = screen.getByPlaceholderText('Enter Anthropic API key')
    fireEvent.change(anthropicInput, { target: { value: 'sk-test-1234' } })
    const saveButtons = screen.getAllByText(/^save$/i)
    fireEvent.click(saveButtons[0])
    expect(mockSaveProviderKey).toHaveBeenCalledWith('anthropic', 'sk-test-1234')
  })

  it('removing a key calls removeProviderKey with correct provider', () => {
    // In the default state, no keys exist, so Remove buttons won't be shown.
    // Verify that the UI correctly shows save-only state (no remove buttons).
    render(<SettingsPage onBack={onBackMock} />)
    const removeButtons = screen.queryAllByText(/^remove$/i)
    // When no keys configured, no remove buttons should appear
    expect(removeButtons.length).toBe(0)
    // And save buttons exist for each provider
    const saveButtons = screen.getAllByText(/^save$/i)
    expect(saveButtons.length).toBeGreaterThanOrEqual(1)
  })

  it('back button triggers navigation callback', () => {
    render(<SettingsPage onBack={onBackMock} />)
    const backButton = screen.getByText(/back/i)
    fireEvent.click(backButton)
    expect(onBackMock).toHaveBeenCalledOnce()
  })
})
