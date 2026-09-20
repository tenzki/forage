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
import { applyActivityEvent, callsFromHistory, fromRuntimeEvent } from './agent/activityCalls'
import { serverRunManager } from './agent/serverRunManager'
import { agentRunSignals } from './agent/agentRunSignals'
import {
  captureDocumentEvent,
  DOMAIN_MUTATION_META,
  type CapturedDocumentEvent,
} from './editor/eventCapture'
import {
  dispatchPersistentRedo,
  dispatchPersistentUndo,
  mergeLoadedHistory,
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
import { captureStepBatch, createOutlineSchema, findSystemNode } from '@forage/document'
import { currentBulletId, focusFirstChildOrCreate, selectBullet } from './editor/outlineModel'
import { setZoom } from './editor/outlinerUi'
import { openOrCreateDailyNote } from './editor/dailyNotes'
import { setEditorMutationLocked } from './editor/extensions'
import { OutlineSession } from './application/OutlineSession'
import { connectServerStream } from './sync/serverStream'
import { streamLiveness } from './sync/streamLiveness'
import type { StreamedBatch } from './sync/syncEngine'
import { SystemAlertBanner } from './components/ui/SystemAlertBanner'
import { KeyboardShortcutsPanel } from './components/KeyboardShortcutsPanel'
import { useMotionPresence } from './components/ui/useMotionPresence'
import { useExtensionStore } from './store/extensionStore'
import { placeRetainedExtensionSkillResult } from './agent/extensionResultPlacement'

type View = 'outliner' | 'settings' | 'trash' | 'tasks'

const SAFETY_SYNC_INTERVAL_MS = 5 * 60_000

const UNSTREAMED_SYNC_INTERVAL_MS = 15_000

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
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const shortcutsPresence = useMotionPresence(shortcutsOpen, 150)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [viewError, setViewError] = useState<string | null>(null)
  const [agentError, setAgentError] = useState<string | null>(null)
  const visibleAgentError = useRef<string | null>(null)
  if (agentError) visibleAgentError.current = agentError
  const agentErrorPresence = useMotionPresence(Boolean(agentError), 250)
  const [activityCalls, setActivityCalls] = useState<ActivityCall[]>([])
  const [activitySidebarCollapsed, setActivitySidebarCollapsed] = useState(false)
  const extensionRunCancellations = useRef(new Map<string, () => void>())
  const loadSettings = useSettingsStore((state) => state.load)
  const refreshExtensions = useExtensionStore((state) => state.refresh)
  const [session] = useState(() => new OutlineSession())
  const sessionStatus = useSyncExternalStore(session.subscribe, session.getSnapshot)
  const persistentHistory = useRef<PersistentHistoryState>({ undo: [], redo: [] })
  const activeChangeGroup = useRef<{ id: string; at: number; key: string } | null>(null)
  const syncInProgress = useRef(false)
  const synchronizeNow = useRef<(streamed?: StreamedBatch) => Promise<void>>(async () => undefined)
  const streamUnsupported = sessionStatus.streamSupported === false

  const handleActivity = useCallback((event: ActivityEvent) => {
    setActivityCalls((current) => applyActivityEvent(current, event))
  }, [])

  const openActivityNode = useCallback((nodeId: string, contextNodeId?: string) => {
    if (!editor) return
    setViewError(null)
    setView('outliner')
    setZoom(editor, contextNodeId ?? nodeId)
    selectBullet(editor, nodeId)
  }, [editor])

  const placeRetainedResult = useCallback(async (runId: string) => {
    if (!editor) return
    const targetNodeId = currentBulletId(editor)
    if (!targetNodeId) {
      setAgentError('Select a live bullet before placing the retained result.')
      return
    }
    try {
      const run = await session.agentRun(runId)
      if (!run) throw new Error('The retained extension result is no longer available.')
      const nodeIds = await placeRetainedExtensionSkillResult(editor, run, targetNodeId, session)
      setActivityCalls((calls) => calls.map((call) => call.id === runId
        ? { ...call, placementPending: false, status: 'complete' }
        : call))
      const firstNodeId = nodeIds[0]
      if (firstNodeId) {
        handleActivity({
          id: `outline-${runId}`,
          callId: runId,
          phase: 'complete',
          kind: 'output',
          label: 'Retained result placed',
          nodeId: firstNodeId,
        })
      }
      setAgentError(null)
    } catch (error) {
      setAgentError(errorMessage(error))
    }
  }, [editor, handleActivity, session])

  const clearActivity = useCallback(() => {
    // A retained paid result is not disposable activity history. Keep its
    // recovery affordance until the user places it successfully.
    setActivityCalls((calls) => calls.filter((call) => call.placementPending))
    void Promise.all([
      session.clearAgentRunHistory(),
      serverRunManager.clearFinishedHistory(),
    ]).catch((error) => setAgentError(errorMessage(error)))
  }, [session])

  const closeShortcuts = useCallback(() => setShortcutsOpen(false), [])

  const readOutline = useCallback(async () => {
    setLoadError(null)
    try {
      const opened = await session.open()
      const { state } = opened
      persistentHistory.current = { undo: [], redo: [] }
      void opened.history.then((loaded) => {
        persistentHistory.current = mergeLoadedHistory(loaded, persistentHistory.current)
      })
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
    // This is a manifest-only local inventory. It never imports extension code,
    // opens a modal, or performs package/network lifecycle work.
    void refreshExtensions().catch(() => undefined)
  }, [loadSettings, readOutline, refreshExtensions])

  useEffect(() => {
    if (!loaded) return
    void serverRunManager.restore((event, runId) => handleActivity(fromRuntimeEvent(event, runId)))
      .then(() => serverRunManager.adoptActive())
      .catch(() => undefined)
  }, [handleActivity, loaded])

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
    const synchronize = async (streamed?: StreamedBatch): Promise<void> => {
      if (syncInProgress.current) {
        await new Promise<void>((resolve) => {
          const wait = window.setInterval(() => {
            if (syncInProgress.current) return
            window.clearInterval(wait)
            resolve()
          }, 25)
        })
        if (!disposed) await synchronize()
        return
      }
      syncInProgress.current = true
      const run = async () => {
        try {
          if (disposed) return
          await session.synchronize(({ state: projected, historyInvalidated, appliedEvents }) => {
            if (disposed) return
            let application: HTMLElement | null = null
            try { application = editor.view.dom.closest<HTMLElement>('#app') } catch { /* editor was destroyed */ }
            const wasEditable = editor.isEditable
            setEditorMutationLocked(editor, true)
            if (application) application.inert = true
            try {
              const nextDoc = projected.doc as JsonValue
              createOutlineSchema().nodeFromJSON(nextDoc as object).check()
              const documentChanged = JSON.stringify(editor.getJSON()) !== JSON.stringify(nextDoc)
              let agentResultHistory: CapturedDocumentEvent | null = null
              if (documentChanged) {
                const projectedDoc = editor.schema.nodeFromJSON(nextDoc as object)
                const transaction = editor.state.tr
                  .replaceWith(0, editor.state.doc.content.size, projectedDoc.content)
                  .setMeta('forageRemote', true)
                  .setMeta('preventUpdate', true)
                  .setMeta('addToHistory', false)
                const remoteResult = appliedEvents.length === 1 && appliedEvents[0]?.type === 'agent.result_committed'
                  ? appliedEvents[0]
                  : null
                if (remoteResult) {
                  agentResultHistory = {
                    id: remoteResult.id,
                    outlineId: remoteResult.outlineId,
                    actorId: remoteResult.actorId,
                    deviceId: remoteResult.deviceId,
                    type: 'document.steps_applied', eventVersion: 1, documentVersion: 1, schemaEpoch: 1,
                    baseRevision: remoteResult.baseRevision,
                    origin: 'server', occurredAt: remoteResult.occurredAt,
                    changeGroupId: remoteResult.changeGroupId ?? `run:${remoteResult.payload.runId}`,
                    payload: captureStepBatch(editor.state.doc, transaction.steps),
                    before: editor.state.doc.toJSON() as Record<string, unknown>,
                    after: projectedDoc.toJSON() as Record<string, unknown>,
                  }
                }
                editor.view.dispatch(transaction)
                if (!editor.state.doc.eq(projectedDoc)) {
                  throw new Error('The synchronized outline projection could not be applied.')
                }
              }
              liveDoc.current = nextDoc
              if ((documentChanged && !agentResultHistory) || historyInvalidated) {
                activeChangeGroup.current = null
                persistentHistory.current = { undo: [], redo: [] }
              } else if (agentResultHistory) {
                activeChangeGroup.current = null
                recordDocumentChange(persistentHistory.current, agentResultHistory)
              }
              setTrash(projected.trash as unknown as TrashEntry[])
              setShortcuts(projected.shortcuts as unknown as OutlineShortcut[])
            } finally {
              setEditorMutationLocked(editor, false)
              if (!editor.isDestroyed) editor.setEditable(wasEditable)
              if (application) application.inert = false
            }
          }, streamed)
        } finally {
          syncInProgress.current = false
        }
      }
      await run()
    }
    synchronizeNow.current = synchronize
    void synchronize()
    let timer = 0
    const scheduleSync = () => {
      const streamed = session.getSnapshot().storageBackend.kind !== 'server'
        || streamLiveness.get() === 'live'
      const wait = streamed ? SAFETY_SYNC_INTERVAL_MS : UNSTREAMED_SYNC_INTERVAL_MS
      timer = window.setTimeout(() => { void synchronize().finally(scheduleSync) }, wait)
    }
    scheduleSync()
    const synchronizeOnWake = () => { void synchronize() }
    window.addEventListener('focus', synchronizeOnWake)
    window.addEventListener('online', synchronizeOnWake)
    return () => {
      disposed = true
      if (synchronizeNow.current === synchronize) synchronizeNow.current = async () => undefined
      window.clearTimeout(timer)
      window.removeEventListener('focus', synchronizeOnWake)
      window.removeEventListener('online', synchronizeOnWake)
    }
  }, [editor, session])

  useEffect(() => {
    if (sessionStatus.storageBackend.kind !== 'server') return
    if (streamUnsupported) {
      streamLiveness.set('unsupported')
      return
    }
    const context = session.context()
    if (!context) return
    let disposed = false
    let disconnect: (() => void) | null = null
    void connectServerStream(context.baseRevision, {
      onBatch: (batch) => {
        if (disposed) return
        void synchronizeNow.current({ outlineId: context.outlineId, ...batch })
      },
      onResync: () => { if (!disposed) void synchronizeNow.current() },
      onAgent: (signal) => {
        agentRunSignals.notify(signal.runId)
        void serverRunManager.adopt(signal.runId).catch(() => undefined)
      },
      onConnected: () => {
        if (disposed) return
        streamLiveness.set('live')
        agentRunSignals.notifyAll()
        void serverRunManager.adoptActive().catch(() => undefined)
        void synchronizeNow.current()
      },
      onDisconnected: () => { if (!disposed) streamLiveness.set('down') },
      onAuthFailed: () => {
        if (disposed) return
        streamLiveness.set('unsupported')
        void synchronizeNow.current()
      },
    }).then((stop) => {
      if (disposed) stop()
      else disconnect = stop
    }).catch(() => streamLiveness.set('down'))
    return () => {
      disposed = true
      streamLiveness.set('down')
      disconnect?.()
    }
  }, [session, sessionStatus.storageBackend.kind, streamUnsupported])

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
      const modifier = event.metaKey || event.ctrlKey
      if (modifier && event.key === ',') {
        event.preventDefault()
        setShortcutsOpen(false)
        setView((current) => (current === 'settings' ? 'outliner' : 'settings'))
      } else if (modifier && (event.key === '?' || (event.shiftKey && event.key === '/'))) {
        event.preventDefault()
        setShortcutsOpen((open) => !open)
      } else if (modifier && !event.shiftKey && !event.altKey && event.code === 'Backslash') {
        event.preventDefault()
        setSidebarCollapsed((collapsed) => !collapsed)
      } else if (modifier && !event.shiftKey && !event.altKey && event.code === 'Slash') {
        event.preventDefault()
        setActivitySidebarCollapsed((collapsed) => !collapsed)
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

  const prepareServerAgentRun = useCallback(async () => {
    const synchronized = await session.synchronize()
    if (synchronized) return
    const state = session.getSnapshot().syncState
    const detail = 'message' in state ? state.message : `Synchronization stopped in state: ${state.kind}`
    throw new Error(`Could not sync this bullet before starting the agent. ${detail}`)
  }, [session])

  const applyServerAgentResult = useCallback(async () => {
    await synchronizeNow.current()
  }, [])

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
    persistentHistory.current = await opened.history
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
      {agentErrorPresence.mounted && visibleAgentError.current && (
        <SystemAlertBanner
          title="Agent error"
          description={visibleAgentError.current}
          onDismiss={() => setAgentError(null)}
          motionState={agentErrorPresence.motionState}
        />
      )}

      <main className="outliner-main">
        <OutlinerSidebar
          editor={editor}
          shortcuts={shortcuts}
          collapsed={sidebarCollapsed}
          trashCount={trash.length}
          activeView={view}
          shortcutsOpen={shortcutsOpen}
          onChange={handleShortcutsChange}
          onOpenOutline={() => { setViewError(null); setView('outliner') }}
          onOpenInbox={openInbox}
          onOpenDailyNotes={openDailyNotes}
          onOpenShortcuts={() => setShortcutsOpen(true)}
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
            <SlashMenu
              editor={editor}
              onError={setAgentError}
              onActivity={handleActivity}
              onBeforeServerRun={prepareServerAgentRun}
              onAfterServerRun={applyServerAgentResult}
              onRegisterExtensionCancellation={(runId, cancel) => {
                if (cancel) extensionRunCancellations.current.set(runId, cancel)
                else extensionRunCancellations.current.delete(runId)
              }}
            />
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
          onPlaceResult={(runId) => void placeRetainedResult(runId)}
          canCancel={(runId) => extensionRunCancellations.current.has(runId)}
          onCancel={(runId) => extensionRunCancellations.current.get(runId)?.()}
        />
      </main>
      {shortcutsPresence.mounted && (
        <KeyboardShortcutsPanel onClose={closeShortcuts} motionState={shortcutsPresence.motionState} />
      )}
    </div>
  )
}
