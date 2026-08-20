import { useCallback, useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { OutlinerEditor } from './editor/OutlinerEditor'
import { SlashMenu } from './components/Agent/SlashMenu'
import { SettingsPanel } from './components/Settings/SettingsPanel'
import { OutlinerChrome } from './components/Outliner/OutlinerChrome'
import { OutlinerSidebar } from './components/Outliner/OutlinerSidebar'
import { FormattingBubbleMenu } from './components/Outliner/FormattingBubbleMenu'
import { TagMenu } from './components/Outliner/TagMenu'
import {
  loadOutline,
  createDebouncedSaver,
  type DebouncedSaver,
} from './persistence/outlineFile'
import { useSettingsStore } from './store/settingsStore'
import type { JsonValue, OutlineShortcut, TrashEntry } from './types/tree'

type View = 'outliner' | 'settings'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export default function App() {
  const [loaded, setLoaded] = useState(false)
  const [initialContent, setInitialContent] = useState<JsonValue | null>(null)
  const [liveDoc, setLiveDoc] = useState<JsonValue | null>(null)
  const [trash, setTrash] = useState<TrashEntry[]>([])
  const [shortcuts, setShortcuts] = useState<OutlineShortcut[]>([])
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
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
      setShortcuts(outline?.shortcuts ?? [])
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
    saver.current?.schedule({ version: 4, doc: liveDoc, trash, shortcuts })
  }, [liveDoc, loaded, shortcuts, trash])

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
    setShortcuts([])
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
      {saveError && (
        <div className="persistence-error" role="alert">
          <span><strong>Outline not saved.</strong> {saveError}</span>
          <button onClick={() => void retrySave()}>Retry</button>
          <button onClick={() => setSaveError(null)}>Dismiss</button>
        </div>
      )}

      <main className="outliner-main" hidden={view === 'settings'}>
        <OutlinerSidebar
          editor={editor}
          shortcuts={shortcuts}
          collapsed={sidebarCollapsed}
          trashCount={trash.length}
          onChange={setShortcuts}
          onOpenSettings={() => setView('settings')}
        />
        <section className="outline-workspace">
          <OutlinerChrome
            editor={editor}
            trash={trash}
            onTrashChange={setTrash}
            shortcuts={shortcuts}
            onShortcutsChange={setShortcuts}
            sidebarCollapsed={sidebarCollapsed}
            onToggleSidebar={() => setSidebarCollapsed((collapsed) => !collapsed)}
          />
          <OutlinerEditor initialContent={initialContent} onDocChange={handleDocChange} onReady={setEditor} />
          <FormattingBubbleMenu editor={editor} />
          <SlashMenu editor={editor} />
          <TagMenu editor={editor} />
        </section>
      </main>

      {view === 'settings' && <SettingsPanel onBack={() => setView('outliner')} />}
    </div>
  )
}
