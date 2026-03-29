import { useState } from 'react'
import type { ProviderConfig } from '../../store/settingsStore'

interface ProviderKeyInputProps {
  provider: string
  label: string
  config: ProviderConfig
  onSave: (key: string) => void
  onRemove: () => void
}

/**
 * Reusable component for managing a single LLM provider's API key.
 * Shows a password input with masked display when a key exists.
 */
export default function ProviderKeyInput({
  provider,
  label,
  config,
  onSave,
  onRemove,
}: ProviderKeyInputProps) {
  const [inputValue, setInputValue] = useState('')
  const [editing, setEditing] = useState(false)

  const hasKey = config.apiKey.length > 0
  const maskedDisplay = hasKey
    ? '••••••••••••' + config.apiKey.slice(-4)
    : ''

  function handleSave() {
    if (inputValue.trim().length === 0) return
    onSave(inputValue.trim())
    setInputValue('')
    setEditing(false)
  }

  function handleRemove() {
    if (window.confirm(`Remove API key for ${label}?`)) {
      onRemove()
      setInputValue('')
      setEditing(false)
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') handleSave()
    if (e.key === 'Escape') {
      setInputValue('')
      setEditing(false)
    }
  }

  return (
    <div className="provider-input" data-provider={provider}>
      <div className="provider-input-header">
        <span className="provider-label">{label}</span>
        {hasKey && (
          <span className="provider-status provider-status--active">Active</span>
        )}
      </div>

      {hasKey && !editing ? (
        <div className="provider-key-row">
          <span className="provider-key-masked">{maskedDisplay}</span>
          <button
            className="btn-secondary"
            onClick={() => setEditing(true)}
          >
            Change
          </button>
          <button
            className="btn-danger"
            onClick={handleRemove}
          >
            Remove
          </button>
        </div>
      ) : (
        <div className="provider-key-row">
          <input
            type="password"
            className="provider-key-input"
            placeholder={`Enter ${label} API key`}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            autoComplete="off"
            spellCheck={false}
          />
          <button
            className="btn-primary"
            onClick={handleSave}
            disabled={inputValue.trim().length === 0}
          >
            Save
          </button>
          {editing && (
            <button
              className="btn-secondary"
              onClick={() => { setInputValue(''); setEditing(false) }}
            >
              Cancel
            </button>
          )}
        </div>
      )}
    </div>
  )
}
