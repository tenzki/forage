import { useCallback, useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { OutlinerEditor } from './editor/OutlinerEditor'
import { SlashMenu } from './components/Agent/SlashMenu'
import { SettingsPanel } from './components/Settings/SettingsPanel'
import { OutlinerChrome } from './components/Outliner/OutlinerChrome'
import { loadOutline, createDebouncedSaver } from './persistence/outlineFile'
import { useSettingsStore } from './store/settingsStore'
import type { JsonValue } from './types/tree'

type View = 'outliner' | 'settings'

export default function App() {
  const [loaded, setLoaded] = useState(false)
  const [initialContent, setInitialContent] = useState<JsonValue | null>(null)
  const [view, setView] = useState<View>('outliner')
  const [editor, setEditor] = useState<Editor | null>(null)
  const saver = useRef(createDebouncedSaver())
  const loadSettings = useSettingsStore((s) => s.load)

  // Initial load: outline file + settings.
  useEffect(() => {
    void (async () => {
      const outline = await loadOutline()
      setInitialContent(outline?.doc ?? null)
      setLoaded(true)
    })()
    void loadSettings()
  }, [loadSettings])

  // Flush any pending save when the window is closing.
  useEffect(() => {
    const flush = () => void saver.current.flush()
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
  }, [])

  // Cmd+, toggles settings.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === ',') {
        e.preventDefault()
        setView((v) => (v === 'settings' ? 'outliner' : 'settings'))
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const handleDocChange = useCallback((doc: JsonValue) => {
    saver.current.schedule({ version: 1, doc })
  }, [])

  if (!loaded) return <div className="app-loading">Loading…</div>

  return (
    <div id="app">
      <header className="app-header">
        <span className="app-title">AI Chat</span>
        <button
          className="app-settings-btn"
          onClick={() => setView((v) => (v === 'settings' ? 'outliner' : 'settings'))}
        >
          {view === 'settings' ? 'Outline' : 'Settings'}
        </button>
      </header>

      {/*
        The editor is mounted for the lifetime of the app and only hidden when
        Settings is open. Unmounting it would drop the live document and the
        ProseMirror undo stack, and remount it from the startup snapshot.
      */}
      <main className="outliner-main" hidden={view === 'settings'}>
        <OutlinerChrome editor={editor} />
        <OutlinerEditor
          initialContent={initialContent}
          onDocChange={handleDocChange}
          onReady={setEditor}
        />
        <SlashMenu editor={editor} />
      </main>

      {view === 'settings' && <SettingsPanel onBack={() => setView('outliner')} />}
    </div>
  )
}
