import { useEffect, useState } from 'react'
import OutlinerView from './components/Outliner/OutlinerView'
import SearchOverlay from './components/Search/SearchOverlay'
import TagSidebar from './components/TagSidebar/TagSidebar'
import SettingsPage from './components/Settings/SettingsPage'
import { useTreeStore } from './store/treeStore'

type CurrentView = 'outliner' | 'settings'

export default function App() {
  const [currentView, setCurrentView] = useState<CurrentView>('outliner')
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const undo = useTreeStore((s) => s.undo)
  const redo = useTreeStore((s) => s.redo)
  const registerTagClickHandler = useTreeStore((s) => s.registerTagClickHandler)

  // Register the tag click handler so NodeEditor can call it
  useEffect(() => {
    registerTagClickHandler((tag: string) => {
      setSearchQuery('#' + tag)
      setSearchOpen(true)
    })
  }, [registerTagClickHandler])

  useEffect(() => {
    // capture: true intercepts Cmd+K/Z/\ before TipTap's stopPropagation
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === 'k') {
        e.preventDefault()
        setSearchQuery('')
        setSearchOpen(true)
      }
      // Toggle tag sidebar with Cmd+\
      if (e.metaKey && e.key === '\\') {
        e.preventDefault()
        setSidebarOpen((open) => !open)
      }
      // Global undo/redo — handles case when no editor is focused
      if (e.metaKey && e.key === 'z' && !e.shiftKey) {
        e.preventDefault()
        undo().catch(console.error)
      }
      if (e.metaKey && e.key === 'z' && e.shiftKey) {
        e.preventDefault()
        redo().catch(console.error)
      }
      // Cmd+, opens settings
      if (e.metaKey && e.key === ',') {
        e.preventDefault()
        setCurrentView((v) => v === 'settings' ? 'outliner' : 'settings')
      }
    }
    window.addEventListener('keydown', handler, { capture: true })
    return () => window.removeEventListener('keydown', handler, { capture: true })
  }, [undo, redo])

  function handleTagClick(tag: string) {
    setSearchQuery('#' + tag)
    setSearchOpen(true)
  }

  function handleSearchClose() {
    setSearchOpen(false)
    setSearchQuery('')
  }

  if (currentView === 'settings') {
    return <SettingsPage onBack={() => setCurrentView('outliner')} />
  }

  return (
    <div id="app" style={{ display: 'flex', flexDirection: 'row', position: 'relative' }}>
      <TagSidebar open={sidebarOpen} onTagClick={handleTagClick} />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <OutlinerView />
      </div>

      {/* Gear icon — top-right corner, subtle until hover */}
      <button
        className="gear-icon"
        onClick={() => setCurrentView('settings')}
        title="Settings (Cmd+,)"
        aria-label="Open settings"
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>

      <SearchOverlay
        open={searchOpen}
        onClose={handleSearchClose}
        initialQuery={searchQuery}
      />
    </div>
  )
}
