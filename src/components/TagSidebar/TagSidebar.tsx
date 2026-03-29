import { useEffect, useState } from 'react'
import { getAllTagsIpc } from '../../store/ipc'
import type { TagCount } from '../../store/ipc'
import TagList from './TagList'
import { useSettingsStore } from '../../store/settingsStore'
import ProviderKeyInput from '../Settings/ProviderKeyInput'

interface TagSidebarProps {
  open: boolean
  onTagClick: (tag: string) => void
  onToggle: () => void
  /** If true, open the sidebar and switch to the settings section */
  focusSettings?: boolean
  onSettingsFocused?: () => void
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
 * Toggleable left sidebar showing the tag list.
 * A "Settings" item at the bottom of the list expands a settings panel inline.
 * Always renders — shows collapsed state (icon strip) when closed.
 */
export default function TagSidebar({ open, onTagClick, onToggle, focusSettings, onSettingsFocused }: TagSidebarProps) {
  const [tags, setTags] = useState<TagCount[]>([])
  const [settingsOpen, setSettingsOpen] = useState(false)

  const settings = useSettingsStore((s) => s.settings)
  const isLoaded = useSettingsStore((s) => s.isLoaded)
  const loadSettings = useSettingsStore((s) => s.loadSettings)
  const saveProviderKey = useSettingsStore((s) => s.saveProviderKey)
  const removeProviderKey = useSettingsStore((s) => s.removeProviderKey)
  const setDefaultModel = useSettingsStore((s) => s.setDefaultModel)

  // When focusSettings signal arrives, open sidebar and expand settings
  useEffect(() => {
    if (focusSettings) {
      setSettingsOpen(true)
      onSettingsFocused?.()
    }
  }, [focusSettings, onSettingsFocused])

  // Load tags whenever the sidebar becomes open
  useEffect(() => {
    if (!open) return
    getAllTagsIpc()
      .then(setTags)
      .catch((e) => console.error('Failed to load tags:', e))
  }, [open])

  // Load settings whenever the settings panel is expanded
  useEffect(() => {
    if (settingsOpen) {
      loadSettings()
    }
  }, [settingsOpen, loadSettings])

  function handleSettingsItemClick() {
    setSettingsOpen((prev) => !prev)
  }

  return (
    <div className={`tag-sidebar${open ? '' : ' tag-sidebar--collapsed'}`}>
      {open && (
        <>
          {/* Tags list */}
          <div className="tag-sidebar-content">
            <TagList tags={tags} onTagClick={onTagClick} />
          </div>

          {/* Settings list item — styled like a tag item */}
          <div className="tag-sidebar-footer">
            <button
              className={`sidebar-settings-item${settingsOpen ? ' sidebar-settings-item--active' : ''}`}
              onClick={handleSettingsItemClick}
              aria-expanded={settingsOpen}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              Settings
            </button>

            {/* Inline settings panel — expands below the Settings item */}
            {settingsOpen && (
              <div className="tag-sidebar-settings">
                {!isLoaded ? (
                  <div className="sidebar-settings-loading">Loading...</div>
                ) : (
                  <>
                    <div className="sidebar-settings-section">
                      <div className="sidebar-settings-section-title">API Keys</div>
                      <p className="sidebar-settings-section-desc">
                        Stored encrypted on your device.
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
                    </div>

                    <div className="sidebar-settings-section">
                      <div className="sidebar-settings-section-title">Default Model</div>
                      <p className="sidebar-settings-section-desc">
                        Used when no model is specified.
                      </p>
                      <select
                        className="sidebar-settings-model-select"
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
                  </>
                )}
              </div>
            )}
          </div>
        </>
      )}

      {/* Collapsed state: icon strip */}
      {!open && (
        <div className="tag-sidebar-collapsed-icons">
          <button
            className="sidebar-icon-btn"
            title="Tags (Cmd+\)"
            aria-label="Open sidebar"
            onClick={onToggle}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
              <line x1="7" y1="7" x2="7.01" y2="7" />
            </svg>
          </button>
          <button
            className="sidebar-icon-btn"
            title="Settings (Cmd+,)"
            aria-label="Open settings"
            onClick={() => {
              onToggle()
              setSettingsOpen(true)
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
      )}
    </div>
  )
}
