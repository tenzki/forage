import { useEffect, useState } from 'react'
import OutlinerView from './components/Outliner/OutlinerView'
import SearchOverlay from './components/Search/SearchOverlay'
import { useTreeStore } from './store/treeStore'

export default function App() {
  const [searchOpen, setSearchOpen] = useState(false)
  const undo = useTreeStore((s) => s.undo)
  const redo = useTreeStore((s) => s.redo)

  useEffect(() => {
    // capture: true intercepts Cmd+K/Z before TipTap's stopPropagation
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === 'k') {
        e.preventDefault()
        setSearchOpen(true)
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
    }
    window.addEventListener('keydown', handler, { capture: true })
    return () => window.removeEventListener('keydown', handler, { capture: true })
  }, [undo, redo])

  return (
    <div id="app">
      <OutlinerView />
      <SearchOverlay open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  )
}
