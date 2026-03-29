import { useEffect, useState } from 'react'
import { getAllTagsIpc } from '../../store/ipc'
import type { TagCount } from '../../store/ipc'
import TagList from './TagList'

interface TagSidebarProps {
  open: boolean
  onTagClick: (tag: string) => void
  onToggle: () => void
  /** Called when user clicks the Settings item */
  onSettingsClick: () => void
  /** Whether the settings view is currently active (for active state styling) */
  settingsActive?: boolean
}

/**
 * Toggleable left sidebar showing the tag list.
 * A "Settings" item at the bottom calls onSettingsClick to swap the main panel.
 * Settings does NOT render inside the sidebar.
 * Always renders — shows collapsed state (icon strip) when closed.
 */
export default function TagSidebar({ open, onTagClick, onToggle, onSettingsClick, settingsActive }: TagSidebarProps) {
  const [tags, setTags] = useState<TagCount[]>([])

  // Load tags whenever the sidebar becomes open
  useEffect(() => {
    if (!open) return
    getAllTagsIpc()
      .then(setTags)
      .catch((e) => console.error('Failed to load tags:', e))
  }, [open])

  return (
    <div className={`tag-sidebar${open ? '' : ' tag-sidebar--collapsed'}`}>
      {open && (
        <>
          {/* Tags list */}
          <div className="tag-sidebar-content">
            <TagList tags={tags} onTagClick={onTagClick} />
          </div>

          {/* Settings list item — styled like a tag item, at the bottom */}
          <div className="tag-sidebar-footer">
            <button
              className={`sidebar-settings-item${settingsActive ? ' sidebar-settings-item--active' : ''}`}
              onClick={onSettingsClick}
              aria-pressed={settingsActive}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              Settings
            </button>
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
            className={`sidebar-icon-btn${settingsActive ? ' sidebar-icon-btn--active' : ''}`}
            title="Settings (Cmd+,)"
            aria-label="Open settings"
            onClick={onSettingsClick}
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
