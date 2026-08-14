// Minimal settings: paste your Anthropic API key. Stored locally via plugin-store.
// The key never leaves your machine except in direct calls to the Anthropic API.

import { useEffect, useState } from 'react'
import { useSettingsStore } from '../../store/settingsStore'

export function SettingsPanel({ onBack }: { onBack: () => void }) {
  const apiKey = useSettingsStore((s) => s.apiKey)
  const isLoaded = useSettingsStore((s) => s.isLoaded)
  const setApiKey = useSettingsStore((s) => s.setApiKey)
  const loadSettings = useSettingsStore((s) => s.load)

  const [draft, setDraft] = useState('')
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (!isLoaded) void loadSettings()
  }, [isLoaded, loadSettings])

  useEffect(() => {
    setDraft(apiKey)
  }, [apiKey])

  async function handleSave() {
    await setApiKey(draft.trim())
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
  }

  return (
    <div className="settings-panel">
      <header className="settings-header">
        <button className="settings-back" onClick={onBack}>← Back</button>
        <h1>Settings</h1>
      </header>

      <section className="settings-section">
        <label htmlFor="anthropic-key">Anthropic API key</label>
        <input
          id="anthropic-key"
          type="password"
          placeholder="sk-ant-..."
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <p className="settings-hint">
          Stored locally on this device. Used only for direct requests to the
          Anthropic API. Get a key at console.anthropic.com.
        </p>
        <button className="settings-save" onClick={handleSave} disabled={!isLoaded}>
          {saved ? 'Saved ✓' : 'Save'}
        </button>
      </section>
    </div>
  )
}
