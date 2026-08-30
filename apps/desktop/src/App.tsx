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
import { TasksPanel } from './components/Outliner/TasksPanel'
import { TagMenu } from './components/Outliner/TagMenu'
import { ActivitySidebar, type ActivityCall, type ActivityEntry } from './components/Agent/ActivitySidebar'
import type { ActivityEvent } from './agent/activity'
import {
  NativeEventRepository,
  type LocalIdentity,
} from './persistence/eventStore'
import { buildDocumentEvent } from './editor/eventCapture'
import { mergeAgentDocumentEvents } from './editor/agentEventBatch'
import {
  dispatchPersistentRedo,
  dispatchPersistentUndo,
  rebuildPersistentHistory,
  recordDocumentChange,
  type PersistentHistoryState,
} from './editor/persistentHistory'
import { createAssetReferenceEvents, createDomainEvents } from './persistence/domainEvents'
import { DesktopSyncEngine, NativeSyncTransport, type SyncState } from './sync/syncEngine'
import { EMPTY_DOC, normalizeOutlinerDoc } from './editor/emptyDoc'
import {
  createInitialOutlineState,
  buildSystemNodeRepairEvent,
  replayOutlineEvents,
  sha256Hex,
  type EventEnvelope,
  type OutlineState,
} from '@forage/domain'
import { useSettingsStore } from './store/settingsStore'
import type { JsonValue, OutlineShortcut, TrashEntry } from './types/tree'
import { newNodeId } from './types/tree'
import {
  SYSTEM_MAINTENANCE_META,
  SYSTEM_NODE_REJECTION_EVENT,
  SYSTEM_NODE_REJECTION_MESSAGE,
} from './editor/systemNodeGuards'
import { findSystemNode } from '@forage/document'
import { focusFirstChildOrCreate } from './editor/outlineModel'
import { setZoom } from './editor/outlinerUi'
import { openOrCreateDailyNote } from './editor/dailyNotes'

type View = 'outliner' | 'settings' | 'trash' | 'tasks'
type StorageBackend = { kind: 'local' } | { kind: 'server'; origin: string }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
  const [saveError, setSaveError] = useState<string | null>(null)
  const [viewError, setViewError] = useState<string | null>(null)
  const [agentError, setAgentError] = useState<string | null>(null)
  const [activityCalls, setActivityCalls] = useState<ActivityCall[]>([])
  const [activitySidebarCollapsed, setActivitySidebarCollapsed] = useState(false)
  const [syncState, setSyncState] = useState<SyncState>({ kind: 'offline' })
  const [storageBackend, setStorageBackend] = useState<StorageBackend>({ kind: 'local' })
  const loadSettings = useSettingsStore((state) => state.load)
  const repository = useRef(new NativeEventRepository())
  const identity = useRef<LocalIdentity | null>(null)
  const localSequence = useRef(0)
  const serverRevision = useRef(0)
  const appendQueue = useRef<Promise<void>>(Promise.resolve())
  const failedEvents = useRef<EventEnvelope[]>([])
  const persistentHistory = useRef<PersistentHistoryState>({ undo: [], redo: [] })
  const activeChangeGroup = useRef<{ id: string; at: number; origin: string } | null>(null)
  const pendingAgentEvents = useRef<Extract<EventEnvelope, { type: 'document.steps_applied' }>[]>([])
  const agentBatchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const syncInProgress = useRef(false)
  const checkpointInProgress = useRef(false)

  const handleActivity = useCallback((event: ActivityEvent) => {
    setActivityCalls((current) => {
      const status = event.status ?? (
        event.phase === 'start' ? 'running' :
          event.phase === 'error' ? 'error' :
            event.phase === 'cancelled' ? 'cancelled' : 'complete'
      )
      const callId = event.callId ?? event.id
      const existingCall = current.find((call) => call.id === callId)
      const existingEvent = existingCall?.events.find((entry) => entry.id === event.id)
      const nextEvent: ActivityEntry = {
        id: event.id,
        kind: event.kind,
        label: event.label,
        detail: event.detail,
        status,
        timestamp: existingEvent?.timestamp ?? Date.now(),
        durationMs: event.durationMs,
      }
      if (!existingCall) {
        return [...current, {
          id: callId,
          label: event.callId ? 'Agent execution' : event.label,
          detail: event.callId ? undefined : event.detail,
          status: event.callId ? 'running' : status,
          timestamp: Date.now(),
          durationMs: event.callId ? undefined : event.durationMs,
          events: [nextEvent],
        }].slice(-100)
      }
      const events = existingEvent
        ? existingCall.events.map((entry) => entry.id === event.id ? { ...entry, ...nextEvent, detail: event.detail ?? entry.detail } : entry)
        : [...existingCall.events, nextEvent]
      const isCallEvent = event.id === callId
      return current.map((call) => call.id === callId
        ? {
            ...call,
            label: isCallEvent ? event.label : call.label,
            detail: isCallEvent ? event.detail ?? call.detail : call.detail,
            status: isCallEvent ? status : call.status,
            durationMs: isCallEvent ? event.durationMs ?? call.durationMs : call.durationMs,
            events,
          }
        : call)
    })
  }, [])

  const readOutline = useCallback(async () => {
    setLoadError(null)
    try {
      const mode = await repository.current.storageMode()
      if (mode === 'server') {
        await new DesktopSyncEngine(repository.current, new NativeSyncTransport(), (state) => {
          setSyncState(state)
          if (state.kind === 'up-to-date') serverRevision.current = state.revision
        }).sync()
      } else {
        setSyncState({ kind: 'local-only' })
      }
      const localIdentity = await repository.current.identity()
      const connection = mode === 'server' ? await repository.current.serverConnection() : null
      setStorageBackend(connection
        ? { kind: 'server', origin: connection.origin }
        : { kind: 'local' })
      const activeIdentity = connection ? { ...localIdentity, outlineId: connection.outlineId } : localIdentity
      identity.current = activeIdentity
      const replay = await repository.current.loadReplayInput(activeIdentity.outlineId)
      const allRecords = await repository.current.eventsAfter(activeIdentity.outlineId, 0) ?? []
      persistentHistory.current = rebuildPersistentHistory(allRecords.map((record) => record.envelope as EventEnvelope))
      let state: OutlineState
      if (replay) {
        state = replayOutlineEvents(replay.state, replay.events)
        localSequence.current = replay.events.length > 0
          ? replay.checkpoint.localSequence + replay.events.length
          : replay.checkpoint.localSequence
        serverRevision.current = replay.checkpoint.serverRevision
      } else {
        state = createInitialOutlineState(normalizeOutlinerDoc(EMPTY_DOC) as Record<string, unknown>)
        const stateJson = JSON.stringify(state)
        await repository.current.saveCheckpoint({
          id: crypto.randomUUID(),
          outlineId: activeIdentity.outlineId,
          documentVersion: 1,
          schemaEpoch: 1,
          localSequence: 0,
          serverRevision: 0,
          stateJson,
          integrityHash: await sha256Hex(stateJson),
          createdAt: new Date().toISOString(),
        })
      }
      const systemNodeMigration = await buildSystemNodeRepairEvent(state, {
        ...activeIdentity,
        baseRevision: serverRevision.current,
        nextEventId: () => crypto.randomUUID(),
        nextNodeId: () => crypto.randomUUID(),
      })
      if (systemNodeMigration) {
        localSequence.current = await repository.current.append(systemNodeMigration.event)
        state = systemNodeMigration.state
      }
      const doc = state.doc as JsonValue
      setInitialContent(doc)
      liveDoc.current = doc
      setTrash(state.trash as unknown as TrashEntry[])
      setShortcuts(state.shortcuts as unknown as OutlineShortcut[])
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
    if (!editor || !identity.current) return
    let disposed = false
    const synchronize = async () => {
      if (syncInProgress.current) return
      syncInProgress.current = true
      try {
        const engine = new DesktopSyncEngine(repository.current, new NativeSyncTransport(), (state) => {
          if (disposed) return
          setSyncState(state)
          if (state.kind === 'up-to-date') serverRevision.current = state.revision
        })
        await engine.sync()
        if (disposed || engine.state.kind !== 'up-to-date' || !identity.current) return
        const replay = await repository.current.loadReplayInput(identity.current.outlineId)
        if (!replay) return
        const projected = replayOutlineEvents(replay.state, replay.events)
        const nextDoc = projected.doc as JsonValue
        if (JSON.stringify(editor.getJSON()) !== JSON.stringify(nextDoc)) {
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
          liveDoc.current = nextDoc
        }
        setTrash(projected.trash as unknown as TrashEntry[])
        setShortcuts(projected.shortcuts as unknown as OutlineShortcut[])
      } catch (error) {
        if (!disposed) setSyncState({ kind: 'server-unavailable', message: errorMessage(error) })
      } finally { syncInProgress.current = false }
    }
    const timer = window.setInterval(() => void synchronize(), 15_000)
    return () => { disposed = true; window.clearInterval(timer) }
  }, [editor])

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

  const appendEvent = useCallback((event: EventEnvelope) => {
    appendQueue.current = appendQueue.current.then(async () => {
      try {
        localSequence.current = await repository.current.append(event)
        if (localSequence.current > 0 && localSequence.current % 100 === 0 && !checkpointInProgress.current) {
          checkpointInProgress.current = true
          try {
            const replay = await repository.current.loadReplayInput(event.outlineId)
            if (replay) {
              const state = replayOutlineEvents(replay.state, replay.events)
              const stateJson = JSON.stringify(state)
              await repository.current.saveCheckpoint({
                id: crypto.randomUUID(), outlineId: event.outlineId,
                documentVersion: 1, schemaEpoch: state.schemaEpoch,
                localSequence: localSequence.current,
                serverRevision: Math.max(replay.checkpoint.serverRevision, ...replay.events.map((candidate) => candidate.revision ?? 0)),
                stateJson, integrityHash: await sha256Hex(stateJson), createdAt: new Date().toISOString(),
              })
            }
          } finally { checkpointInProgress.current = false }
        }
        setSaveError(null)
      } catch (error) {
        failedEvents.current.push(event)
        setSaveError(errorMessage(error))
      }
    })
  }, [])

  const flushAgentEvents = useCallback(() => {
    if (agentBatchTimer.current) clearTimeout(agentBatchTimer.current)
    agentBatchTimer.current = null
    const batch = pendingAgentEvents.current.splice(0)
    if (batch.length === 0) return
    const event = mergeAgentDocumentEvents(batch)
    recordDocumentChange(persistentHistory.current, event)
    appendEvent(event)
    for (const reference of createAssetReferenceEvents(event, () => crypto.randomUUID())) appendEvent(reference)
  }, [appendEvent])

  useEffect(() => () => flushAgentEvents(), [flushAgentEvents])

  const handleEditorTransaction = useCallback((
    transaction: Parameters<typeof buildDocumentEvent>[0],
    appendedTransactions: Parameters<typeof buildDocumentEvent>[1],
  ) => {
    const currentIdentity = identity.current
    if (!currentIdentity) return
    const systemMaintenance = transaction.getMeta(SYSTEM_MAINTENANCE_META) === true
    const transactionOrigin = String(transaction.getMeta('forageOrigin') ?? 'desktop')
    const compensation = transaction.getMeta('forageCompensation')
    const now = Date.now()
    const prior = activeChangeGroup.current
    const canReuseGroup = !compensation && prior?.origin === transactionOrigin
      && now - prior.at <= (transactionOrigin === 'agent' ? 250 : 500)
    const changeGroupId = systemMaintenance
      ? `system:${crypto.randomUUID()}`
      : canReuseGroup ? prior.id : crypto.randomUUID()
    activeChangeGroup.current = compensation || systemMaintenance
      ? null
      : { id: changeGroupId, at: now, origin: transactionOrigin }
    void buildDocumentEvent(transaction, appendedTransactions, {
      ...currentIdentity,
      baseRevision: serverRevision.current,
      nextEventId: () => crypto.randomUUID(),
      nextChangeGroupId: () => changeGroupId,
    }).then((event) => {
      if (!event) return
      if (transactionOrigin === 'agent' && event.type === 'document.steps_applied') {
        pendingAgentEvents.current.push(event)
        if (pendingAgentEvents.current.reduce((count, candidate) => count + candidate.payload.steps.length, 0) >= 1_000) {
          flushAgentEvents()
        } else {
          if (agentBatchTimer.current) clearTimeout(agentBatchTimer.current)
          agentBatchTimer.current = setTimeout(flushAgentEvents, 150)
        }
        return
      }
      if (!systemMaintenance) recordDocumentChange(persistentHistory.current, event)
      appendEvent(event)
      if (event.type === 'document.steps_applied') {
        for (const reference of createAssetReferenceEvents(event, () => crypto.randomUUID())) appendEvent(reference)
      }
    })
      .catch((error) => setSaveError(errorMessage(error)))
  }, [appendEvent, flushAgentEvents])

  const handleUndo = useCallback((currentEditor: Editor): boolean => {
    activeChangeGroup.current = null
    return dispatchPersistentUndo(currentEditor, persistentHistory.current) !== null
  }, [])

  const handleRedo = useCallback((currentEditor: Editor): boolean => {
    activeChangeGroup.current = null
    return dispatchPersistentRedo(currentEditor, persistentHistory.current) !== null
  }, [])

  const domainContext = useCallback(() => {
    const currentIdentity = identity.current
    if (!currentIdentity) return null
    return {
      ...currentIdentity,
      baseRevision: serverRevision.current,
      nextEventId: () => crypto.randomUUID(),
    }
  }, [])

  const handleShortcutsChange = useCallback((next: OutlineShortcut[]) => {
    setShortcuts((current) => {
      const context = domainContext()
      if (context) {
        for (const event of createDomainEvents({ type: 'shortcuts', before: current, after: next }, context)) {
          appendEvent(event)
        }
      }
      return next
    })
  }, [appendEvent, domainContext])

  const handleTrashChange = useCallback((next: TrashEntry[]) => {
    setTrash((current) => {
      const context = domainContext()
      if (context) {
        const currentIds = new Set(current.map((entry) => entry.id))
        for (const entry of next) {
          if (!currentIds.has(entry.id)) {
            for (const event of createDomainEvents({ type: 'trash', operation: 'add', entry }, context)) appendEvent(event)
          }
        }
      }
      return next
    })
  }, [appendEvent, domainContext])

  const removeTrashEntry = useCallback((operation: 'restore' | 'purge', entry: TrashEntry) => {
    const context = domainContext()
    if (context) {
      for (const event of createDomainEvents({ type: 'trash', operation, entry }, context)) appendEvent(event)
    }
    setTrash((current) => current.filter((candidate) => candidate.id !== entry.id))
  }, [appendEvent, domainContext])

  async function retrySave() {
    try {
      const retry = failedEvents.current
      failedEvents.current = []
      for (const event of retry) localSequence.current = await repository.current.append(event)
      setSaveError(null)
    } catch (error) {
      setSaveError(errorMessage(error))
    }
  }

  async function startEmpty() {
    const currentIdentity = identity.current ?? await repository.current.identity()
    identity.current = currentIdentity
    const doc = normalizeOutlinerDoc(EMPTY_DOC)
    const state = createInitialOutlineState(doc as Record<string, unknown>)
    const stateJson = JSON.stringify(state)
    await repository.current.saveCheckpoint({
      id: crypto.randomUUID(), outlineId: currentIdentity.outlineId,
      documentVersion: 1, schemaEpoch: 1, localSequence: 0, serverRevision: 0,
      stateJson, integrityHash: await sha256Hex(stateJson), createdAt: new Date().toISOString(),
    })
    setInitialContent(doc)
    liveDoc.current = doc
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
          <button onClick={() => void startEmpty()}>Start with an empty outline</button>
        </div>
        <small>Starting empty does not delete the existing file, but saving new edits may replace it.</small>
      </main>
    )
  }

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
          <button onClick={() => void retrySave()}>Retry</button>
          <button onClick={() => setSaveError(null)}>Dismiss</button>
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
          onClear={() => setActivityCalls([])}
        />
      </main>
    </div>
  )
}
