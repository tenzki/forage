import { useCallback, useEffect, useRef, useState } from 'react'
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
import { ActivitySidebar, type ActivityCall, type ActivityEntry } from './components/Agent/ActivitySidebar'
import type { ActivityEvent } from './agent/activity'
import {
  NativeEventRepository,
  type LocalIdentity,
} from './persistence/eventStore'
import {
  captureDocumentEvent,
  DOMAIN_MUTATION_META,
  finalizeDocumentEvent,
} from './editor/eventCapture'
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
  buildDocumentRepairEvent,
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
import { setEditorMutationLocked } from './editor/extensions'

type View = 'outliner' | 'settings' | 'trash' | 'tasks'
type StorageBackend = { kind: 'local' } | { kind: 'server'; origin: string }

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
  const failedOperations = useRef<Array<() => Promise<void>>>([])
  const persistenceBlocked = useRef(false)
  const persistentHistory = useRef<PersistentHistoryState>({ undo: [], redo: [] })
  const activeChangeGroup = useRef<{ id: string; at: number; key: string } | null>(null)
  const activeAgentCalls = useRef(new Set<string>())
  const syncInProgress = useRef(false)
  const checkpointInProgress = useRef(false)

  const handleActivity = useCallback((event: ActivityEvent) => {
    if (!event.callId) {
      if (event.phase === 'start') activeAgentCalls.current.add(event.id)
      else if (event.phase === 'complete' || event.phase === 'error' || event.phase === 'cancelled') {
        activeAgentCalls.current.delete(event.id)
      }
    }
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
      persistentHistory.current = rebuildPersistentHistory(
        allRecords
          .filter((record) => !record.supersededBy)
          .map((record) => record.envelope as EventEnvelope),
        activeIdentity.deviceId,
      )
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
      const normalizedDoc = normalizeOutlinerDoc(
        state.doc as JsonValue,
        () => crypto.randomUUID(),
      ) as Record<string, unknown>
      const systemNodeMigration = await buildDocumentRepairEvent(state, normalizedDoc, {
        ...activeIdentity,
        baseRevision: serverRevision.current,
        nextEventId: () => crypto.randomUUID(),
      })
      if (systemNodeMigration) {
        localSequence.current = await repository.current.append(systemNodeMigration.event)
        state = systemNodeMigration.state
        persistentHistory.current = { undo: [], redo: [] }
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
          if (disposed || persistenceBlocked.current) return
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
          if (documentChanged || engine.historyInvalidated) {
            activeChangeGroup.current = null
            persistentHistory.current = { undo: [], redo: [] }
          }
          setTrash(projected.trash as unknown as TrashEntry[])
          setShortcuts(projected.shortcuts as unknown as OutlineShortcut[])
        } catch (error) {
          if (!disposed) setSyncState({ kind: 'server-unavailable', message: errorMessage(error) })
        } finally {
          syncInProgress.current = false
          setEditorMutationLocked(editor, false)
          if (!editor.isDestroyed) editor.setEditable(wasEditable)
          if (application) application.inert = false
        }
      }
      appendQueue.current = appendQueue.current.then(run)
    }
    const timer = window.setInterval(synchronize, 15_000)
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

  const persistEventNow = useCallback(async (event: EventEnvelope) => {
    localSequence.current = await repository.current.append(event)
    if (localSequence.current > 0 && localSequence.current % 100 === 0 && !checkpointInProgress.current) {
      // A server-mode checkpoint may only contain acknowledged events. Including
      // pending edits would make the pre-rebase document impossible to recover.
      if (await repository.current.storageMode() === 'server') return
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
  }, [])

  const enqueueOperation = useCallback((operation: () => Promise<void>) => {
    appendQueue.current = appendQueue.current.then(async () => {
      if (persistenceBlocked.current) {
        failedOperations.current.push(operation)
        return
      }
      try {
        await operation()
        setSaveError(null)
      } catch (error) {
        persistenceBlocked.current = true
        failedOperations.current.push(operation)
        setSaveError(errorMessage(error))
      }
    })
  }, [])

  const appendEvent = useCallback((event: EventEnvelope) => {
    enqueueOperation(() => persistEventNow(event))
  }, [enqueueOperation, persistEventNow])

  const handleEditorTransaction = useCallback((
    transaction: Parameters<typeof captureDocumentEvent>[0],
    appendedTransactions: Parameters<typeof captureDocumentEvent>[1],
  ) => {
    const currentIdentity = identity.current
    if (!currentIdentity) return
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
      ...currentIdentity,
      baseRevision: serverRevision.current,
      nextEventId: () => crypto.randomUUID(),
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
    enqueueOperation(async () => {
      const event = await finalizeDocumentEvent(captured)
      await persistEventNow(event)
      if (event.type === 'document.steps_applied') {
        for (const reference of createAssetReferenceEvents(event, () => crypto.randomUUID())) {
          await persistEventNow(reference)
        }
      }
    })
  }, [enqueueOperation, persistEventNow])

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
    setTrash(next)
  }, [])

  const removeTrashEntry = useCallback((operation: 'restore' | 'purge', entry: TrashEntry) => {
    const context = operation === 'purge' ? domainContext() : null
    if (context && operation === 'purge') {
      for (const event of createDomainEvents({ type: 'trash', operation, entry }, context)) appendEvent(event)
    }
    setTrash((current) => current.filter((candidate) => candidate.id !== entry.id))
  }, [appendEvent, domainContext])

  async function retrySave() {
    const retryOperation = appendQueue.current.then(async () => {
      const retry = failedOperations.current.splice(0)
      persistenceBlocked.current = false
      for (let index = 0; index < retry.length; index += 1) {
        try {
          await retry[index]()
        } catch (error) {
          persistenceBlocked.current = true
          failedOperations.current.push(...retry.slice(index))
          setSaveError(errorMessage(error))
          return
        }
      }
      setSaveError(null)
    })
    appendQueue.current = retryOperation
    await retryOperation
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
    activeChangeGroup.current = null
    persistentHistory.current = { undo: [], redo: [] }
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
