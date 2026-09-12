import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Editor } from '@tiptap/react'
import type { Transaction } from '@tiptap/pm/state'
import { OutlinerEditor } from './editor/OutlinerEditor'
import { SlashMenu } from './components/Agent/SlashMenu'
import { SettingsPanel } from './components/Settings/SettingsPanel'
import { OutlinerChrome } from './components/Outliner/OutlinerChrome'
import { BacklinksPanel } from './components/Outliner/BacklinksPanel'
import { OutlinerSidebar } from './components/Outliner/OutlinerSidebar'
import { FormattingBubbleMenu } from './components/Outliner/FormattingBubbleMenu'
import { InternalLinkMenu } from './components/Outliner/InternalLinkMenu'
import { TrashPanel } from './components/Outliner/TrashPanel'
import { TasksPanel } from './components/Outliner/TasksPanel'
import { TagMenu } from './components/Outliner/TagMenu'
import { ActivitySidebar, type ActivityCall } from './components/Agent/ActivitySidebar'
import type { ActivityEvent } from './agent/activity'
import { applyActivityEvent, callsFromHistory } from './agent/activityCalls'
import {
  captureDocumentEvent,
  DOMAIN_MUTATION_META,
} from './editor/eventCapture'
import {
  dispatchPersistentRedo,
  dispatchPersistentUndo,
  recordDocumentChange,
  type PersistentHistoryState,
} from './editor/persistentHistory'
import { createDomainEvents } from './persistence/domainEvents'
import { useSettingsStore } from './store/settingsStore'
import type { JsonValue, OutlineShortcut, TrashEntry } from './types/tree'
import { newNodeId } from './types/tree'
import {
  SYSTEM_MAINTENANCE_META,
  SYSTEM_NODE_REJECTION_EVENT,
  SYSTEM_NODE_REJECTION_MESSAGE,
} from './editor/systemNodeGuards'
import { createOutlineSchema, findSystemNode } from '@forage/document'
import { focusFirstChildOrCreate, selectBullet } from './editor/outlineModel'
import { setZoom } from './editor/outlinerUi'
import { openOrCreateDailyNote } from './editor/dailyNotes'
import { setEditorMutationLocked } from './editor/extensions'
import { OutlineSession } from './application/OutlineSession'
import { SystemAlertBanner } from './components/ui/SystemAlertBanner'

type View = 'outliner' | 'settings' | 'trash' | 'tasks'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function inlineHistoryKey(transaction: Transaction): string | null {
  if (transaction.steps.length !== 1) return null
  const step = transaction.steps[0].toJSON() as {
    stepType?: string
    from?: number
    to?: number
    slice?: { content?: Array<{ type?: string }> }
  }
  if (step.stepType !== 'replace' || step.from === undefined || step.to === undefined) return null
  if (step.slice?.content?.some((node) => !['text', 'hardBreak'].includes(node.type ?? ''))) return null
  const from = transaction.before.resolve(step.from)
  const to = transaction.before.resolve(step.to)
  if (from.parent !== to.parent || !['paragraph', 'bulletNote'].includes(from.parent.type.name)) return null
  for (let depth = from.depth; depth >= 0; depth -= 1) {
    const node = from.node(depth)
    if (node.type.name === 'listItem') return `${String(node.attrs.nodeId)}:${from.parent.type.name}`
  }
  return null
}

export default function App() {
  const [loaded, setLoaded] = useState(false)
  const [initialContent, setInitialContent] = useState<JsonValue | null>(null)
  const liveDoc = useRef<JsonValue | null>(null)
  const [trash, setTrash] = useState<TrashEntry[]>([])
  const [shortcuts, setShortcuts] = useState<OutlineShortcut[]>([])
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [view, setView] = useState<View>('outliner')
  const [editor, setEditor] = useState<Editor | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [viewError, setViewError] = useState<string | null>(null)
  const [agentError, setAgentError] = useState<string | null>(null)
  const [activityCalls, setActivityCalls] = useState<ActivityCall[]>([])
  const [activitySidebarCollapsed, setActivitySidebarCollapsed] = useState(false)
  const loadSettings = useSettingsStore((state) => state.load)
  const [session] = useState(() => new OutlineSession())
  const sessionStatus = useSyncExternalStore(session.subscribe, session.getSnapshot)
  const persistentHistory = useRef<PersistentHistoryState>({ undo: [], redo: [] })
  const activeChangeGroup = useRef<{ id: string; at: number; key: string } | null>(null)
  const activeAgentCalls = useRef(new Set<string>())
  const syncInProgress = useRef(false)

  const handleActivity = useCallback((event: ActivityEvent) => {
    if (!event.callId) {
      if (event.phase === 'start') activeAgentCalls.current.add(event.id)
      else if (event.phase === 'complete' || event.phase === 'error' || event.phase === 'cancelled') {
        activeAgentCalls.current.delete(event.id)
      }
    }
    setActivityCalls((current) => applyActivityEvent(current, event))
  }, [])

  const openActivityNode = useCallback((nodeId: string, contextNodeId?: string) => {
    if (!editor) return
    setViewError(null)
    setView('outliner')
    setZoom(editor, contextNodeId ?? nodeId)
    selectBullet(editor, nodeId)
  }, [editor])

  const clearActivity = useCallback(() => {
    setActivityCalls([])
    void session.clearAgentRunHistory().catch(() => undefined)
  }, [session])

  const readOutline = useCallback(async () => {
    setLoadError(null)
    try {
      const opened = await session.open()
      const { state } = opened
      persistentHistory.current = opened.history
      const doc = state.doc as JsonValue
      setInitialContent(doc)
      liveDoc.current = doc
      setTrash(state.trash as unknown as TrashEntry[])
      setShortcuts(state.shortcuts as unknown as OutlineShortcut[])
      setLoaded(true)
    } catch (error) {
      setLoadError(errorMessage(error))
    }
  }, [session])

  useEffect(() => {
    void readOutline()
    void loadSettings()
  }, [loadSettings, readOutline])

  // Persisted runs rehydrate the sidebar so agent activity survives a restart.
  useEffect(() => {
    if (!loaded) return
    let disposed = false
    void session.agentRunHistory().then((history) => {
      if (disposed || !history.length) return
      setActivityCalls((current) => current.length ? current : callsFromHistory(history))
    }).catch(() => undefined)
    return () => { disposed = true }
  }, [loaded, session])

  useEffect(() => {
    if (!editor || !session.context()) return
    let disposed = false
    const synchronize = () => {
      if (syncInProgress.current || activeAgentCalls.current.size > 0) return
      syncInProgress.current = true
      const wasEditable = editor.isEditable
      const application = editor.view.dom.closest<HTMLElement>('#app')
      setEditorMutationLocked(editor, true)
      editor.setEditable(false)
      if (application) application.inert = true
      const run = async () => {
        try {
          if (disposed) return
          await session.synchronize(({ state: projected, historyInvalidated }) => {
            if (disposed) return
            const nextDoc = projected.doc as JsonValue
            createOutlineSchema().nodeFromJSON(nextDoc as object).check()
            const documentChanged = JSON.stringify(editor.getJSON()) !== JSON.stringify(nextDoc)
            if (documentChanged) {
              const projectedDoc = editor.schema.nodeFromJSON(nextDoc as object)
              const transaction = editor.state.tr
                .replaceWith(0, editor.state.doc.content.size, projectedDoc.content)
                .setMeta('forageRemote', true)
                .setMeta('preventUpdate', true)
                .setMeta('addToHistory', false)
              editor.view.dispatch(transaction)
              if (!editor.state.doc.eq(projectedDoc)) {
                throw new Error('The synchronized outline projection could not be applied.')
              }
            }
            liveDoc.current = nextDoc
            if (documentChanged || historyInvalidated) {
              activeChangeGroup.current = null
              persistentHistory.current = { undo: [], redo: [] }
            }
            setTrash(projected.trash as unknown as TrashEntry[])
            setShortcuts(projected.shortcuts as unknown as OutlineShortcut[])
          })
        } finally {
          syncInProgress.current = false
          setEditorMutationLocked(editor, false)
          if (!editor.isDestroyed) editor.setEditable(wasEditable)
          if (application) application.inert = false
        }
      }
      void run()
    }
    const timer = window.setInterval(synchronize, 15_000)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [editor, session])

  useEffect(() => {
    const handleSystemNodeRejection = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: string }>).detail
      setViewError(detail?.message ?? SYSTEM_NODE_REJECTION_MESSAGE)
    }
    window.addEventListener(SYSTEM_NODE_REJECTION_EVENT, handleSystemNodeRejection)
    return () => window.removeEventListener(SYSTEM_NODE_REJECTION_EVENT, handleSystemNodeRejection)
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

  const handleDocChange = useCallback((doc: JsonValue) => { liveDoc.current = doc }, [])

  const handleEditorTransaction = useCallback((
    transaction: Parameters<typeof captureDocumentEvent>[0],
    appendedTransactions: Parameters<typeof captureDocumentEvent>[1],
  ) => {
    const context = session.context()
    if (!context) return
    const systemMaintenance = transaction.getMeta(SYSTEM_MAINTENANCE_META) === true
    const transactionOrigin = String(transaction.getMeta('forageOrigin') ?? 'desktop')
    const compensation = transaction.getMeta('forageCompensation')
    const domainMutation = transaction.getMeta(DOMAIN_MUTATION_META)
    const explicitGroup = transaction.getMeta('forageChangeGroup')
    const historyExcluded = transaction.getMeta('addToHistory') === false
    const now = Date.now()
    const inlineKey = appendedTransactions.some((appended) => appended.docChanged)
      ? null
      : inlineHistoryKey(transaction)
    const historyKey = transactionOrigin === 'agent'
      ? `agent:${String(explicitGroup ?? 'unscoped')}`
      : inlineKey ? `desktop:${inlineKey}` : null
    const prior = activeChangeGroup.current
    const canReuseGroup = !compensation && historyKey !== null && prior?.key === historyKey
      && (transactionOrigin === 'agent' || now - prior.at <= 500)
    const changeGroupId = systemMaintenance
      ? `system:${crypto.randomUUID()}`
      : canReuseGroup ? prior.id : crypto.randomUUID()
    activeChangeGroup.current = compensation || systemMaintenance || domainMutation || historyKey === null
      ? null
      : { id: changeGroupId, at: now, key: historyKey }
    const captured = captureDocumentEvent(transaction, appendedTransactions, {
      ...context,
      nextChangeGroupId: () => changeGroupId,
    })
    if (!captured) return
    const historyEligible = !systemMaintenance
      && !domainMutation
      && captured.type === 'document.steps_applied'
      && (!historyExcluded || transactionOrigin === 'agent')
    if (historyEligible && captured.type === 'document.steps_applied') {
      recordDocumentChange(persistentHistory.current, captured)
    } else if (!compensation) {
      // An untracked document rewrite invalidates positional inverse steps.
      persistentHistory.current = { undo: [], redo: [] }
    }
    void session.persistCaptured(captured)
  }, [session])

  const handleUndo = useCallback((currentEditor: Editor): boolean => {
    activeChangeGroup.current = null
    return dispatchPersistentUndo(currentEditor, persistentHistory.current) !== null
  }, [])

  const handleRedo = useCallback((currentEditor: Editor): boolean => {
    activeChangeGroup.current = null
    return dispatchPersistentRedo(currentEditor, persistentHistory.current) !== null
  }, [])

  const domainContext = useCallback(() => {
    return session.context()
  }, [session])

  const handleShortcutsChange = useCallback((next: OutlineShortcut[]) => {
    setShortcuts((current) => {
      const context = domainContext()
      if (context) {
        for (const event of createDomainEvents({ type: 'shortcuts', before: current, after: next }, context)) {
          void session.append(event)
        }
      }
      return next
    })
  }, [domainContext, session])

  const handleTrashChange = useCallback((next: TrashEntry[]) => {
    setTrash(next)
  }, [])

  const removeTrashEntry = useCallback((operation: 'restore' | 'purge', entry: TrashEntry) => {
    const context = operation === 'purge' ? domainContext() : null
    if (context && operation === 'purge') {
      for (const event of createDomainEvents({ type: 'trash', operation, entry }, context)) {
        void session.append(event)
      }
    }
    setTrash((current) => current.filter((candidate) => candidate.id !== entry.id))
  }, [domainContext, session])

  async function startEmpty() {
    const opened = await session.startEmpty()
    const doc = opened.state.doc as JsonValue
    setInitialContent(doc)
    liveDoc.current = doc
    activeChangeGroup.current = null
    persistentHistory.current = opened.history
    setTrash(opened.state.trash as unknown as TrashEntry[])
    setShortcuts(opened.state.shortcuts as unknown as OutlineShortcut[])
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
          <button onClick={() => void startEmpty()}>Start with an empty outline</button>
        </div>
        <small>Starting empty does not delete the existing file, but saving new edits may replace it.</small>
      </main>
    )
  }

  const { saveError, maintenanceError, syncState, storageBackend } = sessionStatus
  const storageBackendLabel = storageBackend.kind === 'server'
    ? `server: ${storageBackend.origin}`
    : 'local'

  function openInbox() {
    if (!editor) return
    const inbox = findSystemNode(editor.state.doc, 'inbox')
    if (!inbox) return
    setViewError(null)
    setView('outliner')
    setZoom(editor, inbox.id)
    focusFirstChildOrCreate(editor, inbox.id, newNodeId)
  }

  function openDailyNotes() {
    setViewError(null)
    setView('outliner')
    if (!editor) return
    openOrCreateDailyNote(editor, {
      nextId: newNodeId,
      locale: typeof navigator === 'undefined' ? undefined : navigator.language,
    })
  }

  function openTasks() {
    setViewError(null)
    setView('tasks')
  }

  return (
    <div id="app">
      {saveError && (
        <div className="persistence-error" role="alert">
          <span><strong>Outline not saved.</strong> {saveError}</span>
          <button onClick={() => void session.retrySave()}>Retry</button>
          <button onClick={() => session.dismissSaveError()}>Dismiss</button>
        </div>
      )}
      {maintenanceError && (
        <div className="persistence-warning" role="alert">
          <span><strong>Outline saved, but its recovery checkpoint could not be refreshed.</strong> {maintenanceError}</span>
          <button onClick={() => void session.retryCheckpoint()}>Retry checkpoint</button>
          <button onClick={() => session.dismissMaintenanceError()}>Dismiss</button>
        </div>
      )}
      <div
        className={`storage-backend-widget sync-${syncState.kind}`}
        role="status"
        aria-label={`Storage backend: ${storageBackendLabel}`}
        title={storageBackendLabel}
      >
        {storageBackendLabel}
      </div>
      {agentError && (
        <SystemAlertBanner
          title="Agent error"
          description={agentError}
          onDismiss={() => setAgentError(null)}
        />
      )}

      <main className="outliner-main">
        <OutlinerSidebar
          editor={editor}
          shortcuts={shortcuts}
          collapsed={sidebarCollapsed}
          trashCount={trash.length}
          activeView={view}
          onChange={handleShortcutsChange}
          onOpenOutline={() => { setViewError(null); setView('outliner') }}
          onOpenInbox={openInbox}
          onOpenDailyNotes={openDailyNotes}
          onOpenSettings={() => { setViewError(null); setView('settings') }}
          onOpenTrash={() => { setViewError(null); setView('trash') }}
          onOpenTasks={openTasks}
        />
        <section className="outline-workspace">
          <div className="outline-editor-view" hidden={view !== 'outliner'}>
            <OutlinerChrome
              editor={editor}
              trash={trash}
              onTrashChange={handleTrashChange}
              shortcuts={shortcuts}
              onShortcutsChange={handleShortcutsChange}
              sidebarCollapsed={sidebarCollapsed}
              onToggleSidebar={() => setSidebarCollapsed((collapsed) => !collapsed)}
              activitySidebarCollapsed={activitySidebarCollapsed}
              onToggleActivitySidebar={() => setActivitySidebarCollapsed((collapsed) => !collapsed)}
              onOpenSettings={() => { setViewError(null); setView('settings') }}
              onOpenTrash={() => { setViewError(null); setView('trash') }}
              onOpenInbox={openInbox}
              onOpenDailyNotes={openDailyNotes}
              onOpenTasks={openTasks}
            />
            <OutlinerEditor
              initialContent={initialContent}
              onDocChange={handleDocChange}
              onTransaction={handleEditorTransaction}
              onUndo={handleUndo}
              onRedo={handleRedo}
              onReady={setEditor}
            />
            {editor && <BacklinksPanel editor={editor} />}
            <FormattingBubbleMenu editor={editor} />
            <SlashMenu editor={editor} onError={setAgentError} onActivity={handleActivity} />
            <TagMenu editor={editor} />
            <InternalLinkMenu editor={editor} />
          </div>
          {viewError && <div className="action-error" role="alert">{viewError}<button onClick={() => setViewError(null)}>Dismiss</button></div>}
          {view === 'settings' && <SettingsPanel onBack={() => setView('outliner')} />}
          {view === 'trash' && editor && (
            <TrashPanel
              editor={editor}
              entries={trash}
              onChange={handleTrashChange}
              onRestore={(entry) => removeTrashEntry('restore', entry)}
              onPurge={(entry) => removeTrashEntry('purge', entry)}
              onError={setViewError}
              onClose={() => setView('outliner')}
            />
          )}
          {view === 'tasks' && editor && (
            <TasksPanel editor={editor} onClose={() => setView('outliner')} />
          )}
        </section>
        <ActivitySidebar
          calls={activityCalls}
          collapsed={activitySidebarCollapsed}
          onClear={clearActivity}
          onOpenNode={openActivityNode}
        />
      </main>
    </div>
  )
}
