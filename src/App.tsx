import { useCallback, useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { OutlinerEditor } from './editor/OutlinerEditor'
import { SlashMenu } from './components/Agent/SlashMenu'
import { SettingsPanel } from './components/Settings/SettingsPanel'
import { OutlinerChrome } from './components/Outliner/OutlinerChrome'
import { TagMenu } from './components/Outliner/TagMenu'
import {
  loadOutline,
  createDebouncedSaver,
  type DebouncedSaver,
} from './persistence/outlineFile'
import { useSettingsStore } from './store/settingsStore'
import type { JsonValue, TrashEntry } from './types/tree'

type View = 'outliner' | 'settings'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default function App() {
  const [loaded, setLoaded] = useState(false)
  const [initialContent, setInitialContent] = useState<JsonValue | null>(null)
  const [liveDoc, setLiveDoc] = useState<JsonValue | null>(null)
  const [trash, setTrash] = useState<TrashEntry[]>([])
  const [view, setView] = useState<View>('outliner')
  const [editor, setEditor] = useState<Editor | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const loadSettings = useSettingsStore((state) => state.load)
  const saver = useRef<DebouncedSaver | null>(null)

  if (!saver.current) {
    saver.current = createDebouncedSaver(
      600,
      (error) => setSaveError(errorMessage(error)),
      () => setSaveError(null),
    )
  }

  const readOutline = useCallback(async () => {
    setLoadError(null)
    try {
      const outline = await loadOutline()
      const doc = outline?.doc ?? null
      setInitialContent(doc)
      setLiveDoc(doc)
      setTrash(outline?.trash ?? [])
      setLoaded(true)
    } catch (error) {
      setLoadError(errorMessage(error))
    }
  }, [])

  useEffect(() => {
    void readOutline()
    void loadSettings()
  }, [loadSettings, readOutline])

  useEffect(() => {
    if (!loaded || !liveDoc) return
    saver.current?.schedule({ version: 2, doc: liveDoc, trash })
  }, [liveDoc, loaded, trash])

  useEffect(() => {
    const flush = () => void saver.current?.flush().catch((error) => setSaveError(errorMessage(error)))
    window.addEventListener('beforeunload', flush)
    return () => window.removeEventListener('beforeunload', flush)
  }, [])

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.metaKey && event.key === ',') {
        event.preventDefault()
        setView((current) => (current === 'settings' ? 'outliner' : 'settings'))
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  const handleDocChange = useCallback((doc: JsonValue) => setLiveDoc(doc), [])

  async function retrySave() {
    try {
      await saver.current?.flush()
      setSaveError(null)
    } catch (error) {
      setSaveError(errorMessage(error))
    }
  }

  function startEmpty() {
    setInitialContent(null)
    setLiveDoc(null)
    setTrash([])
    setLoadError(null)
    setLoaded(true)
  }

  if (!loaded) {
    if (!loadError) return <div className="app-loading">Loading…</div>
    return (
      <main className="load-error" role="alert">
        <h1>Could not open your outline</h1>
        <p>{loadError}</p>
        <div>
          <button className="primary-action" onClick={() => void readOutline()}>Retry</button>
          <button onClick={startEmpty}>Start with an empty outline</button>
        </div>
        <small>Starting empty does not delete the existing file, but saving new edits may replace it.</small>
      </main>
    )
  }

  return (
    <div id="app">
      <header className="app-header">
        <span className="app-title">AI Chat</span>
        <button className="app-settings-btn" onClick={() => setView((current) => (current === 'settings' ? 'outliner' : 'settings'))}>
          {view === 'settings' ? 'Outline' : 'Settings'}
        </button>
      </header>

      {saveError && (
        <div className="persistence-error" role="alert">
          <span><strong>Outline not saved.</strong> {saveError}</span>
          <button onClick={() => void retrySave()}>Retry</button>
          <button onClick={() => setSaveError(null)}>Dismiss</button>
        </div>
      )}

      <main className="outliner-main" hidden={view === 'settings'}>
        <OutlinerChrome editor={editor} trash={trash} onTrashChange={setTrash} />
        <OutlinerEditor initialContent={initialContent} onDocChange={handleDocChange} onReady={setEditor} />
        <SlashMenu editor={editor} />
        <TagMenu editor={editor} />
      </main>

      {view === 'settings' && <SettingsPanel onBack={() => setView('outliner')} />}
    </div>
  )
}
