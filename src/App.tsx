import { useEffect, useState } from 'react'
import OutlinerView from './components/Outliner/OutlinerView'
import SearchOverlay from './components/Search/SearchOverlay'

export default function App() {
  const [searchOpen, setSearchOpen] = useState(false)

  useEffect(() => {
    // capture: true intercepts Cmd+K before TipTap's stopPropagation
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === 'k') {
        e.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', handler, { capture: true })
    return () => window.removeEventListener('keydown', handler, { capture: true })
  }, [])

  return (
    <div id="app">
      <OutlinerView />
      <SearchOverlay open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  )
}
