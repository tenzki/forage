import { useCallback, useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { OutlinerEditor } from './editor/OutlinerEditor'
import { SlashMenu } from './components/Agent/SlashMenu'
import { SettingsPanel } from './components/Settings/SettingsPanel'
import { OutlinerChrome } from './components/Outliner/OutlinerChrome'
import { BacklinksPanel } from './components/Outliner/BacklinksPanel'
import { OutlinerSidebar } from './components/Outliner/OutlinerSidebar'
import { FormattingBubbleMenu } from './components/Outliner/FormattingBubbleMenu'
import { InternalLinkMenu } from './components/Outliner/InternalLinkMenu'
import { TrashPanel } from './components/Outliner/TrashPanel'
import { TagMenu } from './components/Outliner/TagMenu'
import {
  loadOutline,
  createDebouncedSaver,
  type DebouncedSaver,
} from './persistence/outlineFile'
import { useSettingsStore } from './store/settingsStore'
import type { JsonValue, OutlineShortcut, TrashEntry } from './types/tree'

type View = 'outliner' | 'settings' | 'trash'

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
  const [viewError, setViewError] = useState<string | null>(null)
  const [agentError, setAgentError] = useState<string | null>(null)
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
      {agentError && (
        <div className="agent-error-popup" role="alert">
          <div>
            <strong>Agent error</strong>
            <span>{agentError}</span>
          </div>
          <button type="button" onClick={() => setAgentError(null)}>Dismiss</button>
        </div>
      )}

      <main className="outliner-main">
        <OutlinerSidebar
          editor={editor}
          shortcuts={shortcuts}
          collapsed={sidebarCollapsed}
          trashCount={trash.length}
          activeView={view}
          onChange={setShortcuts}
          onOpenOutline={() => { setViewError(null); setView('outliner') }}
          onOpenSettings={() => { setViewError(null); setView('settings') }}
          onOpenTrash={() => { setViewError(null); setView('trash') }}
        />
        <section className="outline-workspace">
          <div className="outline-editor-view" hidden={view !== 'outliner'}>
            <OutlinerChrome
              editor={editor}
              trash={trash}
              onTrashChange={setTrash}
              shortcuts={shortcuts}
              onShortcutsChange={setShortcuts}
              sidebarCollapsed={sidebarCollapsed}
              onToggleSidebar={() => setSidebarCollapsed((collapsed) => !collapsed)}
              onOpenSettings={() => { setViewError(null); setView('settings') }}
              onOpenTrash={() => { setViewError(null); setView('trash') }}
            />
            <OutlinerEditor initialContent={initialContent} onDocChange={handleDocChange} onReady={setEditor} />
            {editor && <BacklinksPanel editor={editor} />}
            <FormattingBubbleMenu editor={editor} />
            <SlashMenu editor={editor} onError={setAgentError} />
            <TagMenu editor={editor} />
            <InternalLinkMenu editor={editor} />
          </div>
          {viewError && <div className="action-error" role="alert">{viewError}<button onClick={() => setViewError(null)}>Dismiss</button></div>}
          {view === 'settings' && <SettingsPanel onBack={() => setView('outliner')} />}
          {view === 'trash' && editor && (
            <TrashPanel
              editor={editor}
              entries={trash}
              onChange={setTrash}
              onError={setViewError}
              onClose={() => setView('outliner')}
            />
          )}
        </section>
      </main>
    </div>
  )
}
