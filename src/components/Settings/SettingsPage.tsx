import { useEffect } from 'react'
import { useSettingsStore } from '../../store/settingsStore'
import ProviderKeyInput from './ProviderKeyInput'

interface SettingsPageProps {
  onBack: () => void
}

const ANTHROPIC_MODELS = [
  { value: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
  { value: 'claude-opus-4-20250514',   label: 'Claude Opus 4' },
]

const OPENAI_MODELS = [
  { value: 'gpt-4o',      label: 'GPT-4o' },
  { value: 'gpt-4o-mini', label: 'GPT-4o Mini' },
]

const GOOGLE_MODELS = [
  { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash' },
  { value: 'gemini-2.5-pro',   label: 'Gemini 2.5 Pro' },
]

const ALL_MODELS = [...ANTHROPIC_MODELS, ...OPENAI_MODELS, ...GOOGLE_MODELS]

/**
 * Full-page settings screen for managing LLM provider API keys and default model.
 * Accessible via gear icon in the outliner view.
 */
export default function SettingsPage({ onBack }: SettingsPageProps) {
  const settings = useSettingsStore((s) => s.settings)
  const isLoaded = useSettingsStore((s) => s.isLoaded)
  const loadSettings = useSettingsStore((s) => s.loadSettings)
  const saveProviderKey = useSettingsStore((s) => s.saveProviderKey)
  const removeProviderKey = useSettingsStore((s) => s.removeProviderKey)
  const setDefaultModel = useSettingsStore((s) => s.setDefaultModel)

  useEffect(() => {
    loadSettings()
  }, [loadSettings])

  return (
    <div className="settings-page">
      <div className="settings-header">
        <button className="btn-back" onClick={onBack}>
          &larr; Back
        </button>
        <h1 className="settings-title">Settings</h1>
      </div>

      {!isLoaded ? (
        <div className="settings-loading">Loading settings...</div>
      ) : (
        <div className="settings-content">
          <section className="settings-section">
            <h2 className="settings-section-title">API Keys</h2>
            <p className="settings-section-desc">
              Keys are stored encrypted on your device and never leave your machine.
            </p>

            <ProviderKeyInput
              provider="anthropic"
              label="Anthropic"
              config={settings.providers.anthropic}
              onSave={(key) => saveProviderKey('anthropic', key)}
              onRemove={() => removeProviderKey('anthropic')}
            />

            <ProviderKeyInput
              provider="openai"
              label="OpenAI"
              config={settings.providers.openai}
              onSave={(key) => saveProviderKey('openai', key)}
              onRemove={() => removeProviderKey('openai')}
            />

            <ProviderKeyInput
              provider="google"
              label="Google"
              config={settings.providers.google}
              onSave={(key) => saveProviderKey('google', key)}
              onRemove={() => removeProviderKey('google')}
            />
          </section>

          <section className="settings-section">
            <h2 className="settings-section-title">Default Model</h2>
            <p className="settings-section-desc">
              Used when no model is specified for an AI action.
            </p>
            <div className="settings-model-row">
              <select
                className="settings-model-select"
                value={settings.defaultModel}
                onChange={(e) => setDefaultModel(e.target.value)}
              >
                {ALL_MODELS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
