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
      <TagSidebar
        open={sidebarOpen}
        onTagClick={handleTagClick}
        onSettingsClick={() => setCurrentView('settings')}
      />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <OutlinerView />
      </div>

      <SearchOverlay
        open={searchOpen}
        onClose={handleSearchClose}
        initialQuery={searchQuery}
      />
    </div>
  )
}
