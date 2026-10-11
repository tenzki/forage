import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowLeft,
  ArrowRight,
  BookmarkPlus,
  ChevronRight,
  CalendarDays,
  Home,
  Inbox,
  ListTodo,
  Settings,
  Trash2,
} from 'lucide-react'
import type { Editor } from '@tiptap/react'
import { editorPaneId, ownsPaneEvent } from '../../editor/documentAccess'
import { requestInternalNavigation } from '../../editor/internalLinks'
import {
  breadcrumbFor,
  collectBullets,
  currentBulletId,
  normalizeSearchText,
  searchBullets,
  searchText,
  selectBullet,
  type BulletEntry,
} from '../../editor/outlineModel'
import {
  getOutlinerUiState,
  navigateBack,
  navigateForward,
  OUTLINER_DAILY_DATE_EVENT,
  OUTLINER_NODE_MENU_EVENT,
  OUTLINER_OPEN_SEARCH_EVENT,
  setSearchQuery,
  setZoom,
  type NodeMenuRequest,
  type DailyDateRequest,
  type SearchRequest,
} from '../../editor/outlinerUi'
import { openOrCreateDailyNote } from '../../editor/dailyNotes'
import { newNodeId } from '../../types/tree'
import { OUTLINE_INTERNAL_LINK_EVENT } from '../../editor/internalLinks'
import { OUTLINE_TAG_EVENT } from '../../editor/tags'
import type { OutlineShortcut, TrashEntry } from '../../types/tree'
import { NodeActions } from './NodeActions'
import { SearchInput } from '../ui/SearchInput'
import { IconButton } from '../ui/IconButton'
import { validateSystemNodeAction } from '../../editor/systemNodeGuards'
import { useMotionPresence, type MotionPresenceState } from '../ui/useMotionPresence'
import { FilterChip } from '../ui/FilterChip'
import { Kbd } from '../ui/Kbd'

function displayText(entry: BulletEntry): string {
  return entry.text.trim() || 'Untitled'
}

function useEditorUi(editor: Editor | null) {
  const [, setRevision] = useState(0)
  useEffect(() => {
    if (!editor) return
    const update = () => setRevision((value) => value + 1)
    editor.on('transaction', update)
    return () => {
      editor.off('transaction', update)
    }
  }, [editor])
  return editor ? getOutlinerUiState(editor) : null
}

function Breadcrumbs({ editor, zoomId }: { editor: Editor; zoomId: string | null }) {
  const path = breadcrumbFor(editor.state.doc, zoomId)
  return (
    <nav className="outline-breadcrumbs" aria-label="Outline location">
      <button className="breadcrumb-home" onClick={() => setZoom(editor, null)}>Home</button>
      {path.map((entry) => (
        <span className="breadcrumb-segment" key={entry.id}>
          <ChevronRight className="breadcrumb-separator" size={13} aria-hidden="true" />
          <button onClick={() => setZoom(editor, entry.id)}>{displayText(entry)}</button>
        </span>
      ))}
    </nav>
  )
}

function Toolbar({ editor, zoomId, canNavigateBack, canNavigateForward, onNavigateBack, onNavigateForward, paneActions }: {
  editor: Editor; zoomId: string | null; canNavigateBack: boolean; canNavigateForward: boolean
  onNavigateBack: () => void; onNavigateForward: () => void; paneActions?: React.ReactNode
}) {
  return <div className="outline-toolbar-bar">
    <div className="pane-history" aria-label="Navigation history">
      <IconButton label="Go back" aria-keyshortcuts="Meta+[ Control+[" title="Back (⌘[ / Ctrl+[)" disabled={!canNavigateBack} onClick={onNavigateBack}><ArrowLeft size={16} /></IconButton>
      <IconButton label="Go forward" aria-keyshortcuts="Meta+] Control+]" title="Forward (⌘] / Ctrl+])" disabled={!canNavigateForward} onClick={onNavigateForward}><ArrowRight size={16} /></IconButton>
    </div>
    <Breadcrumbs editor={editor} zoomId={zoomId} />
    {paneActions}
  </div>
}

function resultPath(entry: BulletEntry, entries: BulletEntry[]): string {
  const byId = new Map(entries.map((item) => [item.id, item]))
  return entry.ancestorIds
    .map((id) => byId.get(id)?.text.trim())
    .filter(Boolean)
    .join(' › ')
}

function SearchResultRow({
  entry,
  path,
  active,
  onChoose,
}: {
  entry: BulletEntry
  path: string
  active: boolean
  onChoose: () => void
}) {
  return (
    <li className={active ? 'search-result active' : 'search-result'}>
      <button
        className="search-result-button"
        aria-label={`Open ${displayText(entry)}`}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onChoose}
      >
        <span className="search-result-glyph" aria-hidden="true" />
        <span className="search-result-copy">
          <span className="search-result-title">{displayText(entry)}</span>
          <small>
            {entry.noteText ? `${path ? `Home › ${path}` : 'Home'} · Note: ${entry.noteText}` : (path ? `Home › ${path}` : 'Home')}
          </small>
        </span>
        {active && <Kbd className="search-result-enter border-rule! bg-paper-raised!" aria-hidden="true">enter</Kbd>}
      </button>
    </li>
  )
}

function SearchResults({
  entries,
  allEntries,
  query,
  active,
  hasCommands,
  onChoose,
}: {
  entries: BulletEntry[]
  allEntries: BulletEntry[]
  query: string
  active: number
  hasCommands: boolean
  onChoose: (entry: BulletEntry) => void
}) {
  if (!query.trim() || (!entries.length && hasCommands)) return null
  if (!entries.length) return <p className="search-empty">No matching commands or bullets.</p>
  return (
    <>
    <h3 className="search-section-heading">Bullets · {entries.length}</h3>
    <ul className="search-results" aria-label="Matching bullets">
      {entries.map((entry, index) => (
        <SearchResultRow
          key={entry.id}
          entry={entry}
          path={resultPath(entry, allEntries)}
          active={index === active}
          onChoose={() => onChoose(entry)}
        />
      ))}
    </ul>
    </>
  )
}

function SaveSearchControl({
  query,
  onSave,
}: {
  query: string
  onSave: (label: string) => void
}) {
  const [naming, setNaming] = useState(false)
  const [label, setLabel] = useState('')

  function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!label.trim() || !query.trim()) return
    onSave(label.trim())
    setLabel('')
    setNaming(false)
  }

  if (!naming) {
    return (
      <button className="save-search-open" disabled={!query.trim()} onClick={() => setNaming(true)}>
        <BookmarkPlus size={13} aria-hidden="true" /> Save search
      </button>
    )
  }
  return (
    <form className="save-search-form" onSubmit={submit}>
      <input
        aria-label="Saved search name"
        placeholder="Search name"
        value={label}
        onChange={(event) => setLabel(event.target.value)}
        autoFocus
      />
      <button type="submit" disabled={!label.trim()}>Save</button>
      <button type="button" onClick={() => setNaming(false)}>Cancel</button>
    </form>
  )
}

interface SearchCommand {
  id: 'home' | 'inbox' | 'daily-notes' | 'tasks' | 'settings' | 'trash'
  label: string
  description: string
  run: () => void
}

function SearchCommands({
  commands,
  active,
  onChoose,
}: {
  commands: SearchCommand[]
  active: number
  onChoose: (command: SearchCommand) => void
}) {
  if (!commands.length) return null
  return (
    <>
    <h3 className="search-section-heading">Commands</h3>
    <ul className="search-commands" aria-label="Commands">
      {commands.map((command, index) => (
        <li key={command.id} className={index === active ? 'active' : ''}>
          <button onMouseDown={(event) => event.preventDefault()} onClick={() => onChoose(command)}>
            {command.id === 'home' && <Home size={17} aria-hidden="true" />}
            {command.id === 'inbox' && <Inbox size={17} aria-hidden="true" />}
            {command.id === 'daily-notes' && <CalendarDays size={17} aria-hidden="true" />}
            {command.id === 'tasks' && <ListTodo size={17} aria-hidden="true" />}
            {command.id === 'settings' && <Settings size={17} aria-hidden="true" />}
            {command.id === 'trash' && <Trash2 size={17} aria-hidden="true" />}
            <span><strong>{command.label}</strong><small>{command.description}</small></span>
            <span className="search-command-open">Open</span>
          </button>
        </li>
      ))}
    </ul>
    </>
  )
}

const SEARCH_FILTERS = [
  { label: 'All', token: null },
  { label: 'Todos', token: 'is:todo' },
  { label: 'Open todos', token: 'is:open' },
  { label: 'Completed', token: 'is:complete' },
] as const

const SEARCH_FILTER_PATTERN = /(^|\s)is:(todo|open|complete)(?=\s|$)/giu

function searchFilterToken(query: string): string | null {
  const match = query.match(/(?:^|\s)(is:(?:todo|open|complete))(?=\s|$)/iu)
  return match ? match[1].toLowerCase() : null
}

function withSearchFilter(query: string, token: string | null): string {
  const rest = query.replace(SEARCH_FILTER_PATTERN, ' ').replace(/\s+/gu, ' ').trim()
  return [token, rest].filter(Boolean).join(' ')
}

function OutlineSearch({
  editor,
  initialQuery,
  onSaveSearch,
  onOpenHome,
  onOpenInbox,
  onOpenDailyNotes,
  onOpenTasks,
  onOpenSettings,
  onOpenTrash,
  onClose,
  motionState,
}: {
  editor: Editor
  initialQuery: string
  onSaveSearch: (query: string, label: string, scopeId: string | null) => void
  onOpenHome: () => void
  onOpenInbox: () => void
  onOpenDailyNotes: () => void
  onOpenTasks: () => void
  onOpenSettings: () => void
  onOpenTrash: () => void
  onClose: () => void
  motionState: MotionPresenceState
}) {
  const [query, setQuery] = useState(initialQuery)
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const allEntries = collectBullets(editor.state.doc)
  const results = query.trim() ? searchBullets(allEntries, query) : []
  const commands: SearchCommand[] = [
    { id: 'home', label: 'Home', description: 'Return to the full outline', run: onOpenHome },
    { id: 'inbox', label: 'Inbox', description: 'Open captured notes', run: onOpenInbox },
    { id: 'daily-notes', label: 'Daily Notes', description: "Open today's daily note", run: onOpenDailyNotes },
    { id: 'tasks', label: 'Tasks', description: 'Open all tasks', run: onOpenTasks },
    { id: 'settings', label: 'Settings', description: 'Configure connections, agents, and tools', run: onOpenSettings },
    { id: 'trash', label: 'Trash', description: 'Review and restore deleted items', run: onOpenTrash },
  ]
  const commandTerms = normalizeSearchText(searchText(query)).trim().split(/\s+/u).filter(Boolean)
  const matchingCommands = commands.filter((command) => {
    const text = normalizeSearchText(`${command.label} ${command.description}`)
    return commandTerms.every((term) => text.includes(term))
  })
  const resultCount = matchingCommands.length + results.length
  const activeFilter = searchFilterToken(query)

  useEffect(() => {
    setQuery(initialQuery)
    setActive(0)
    inputRef.current?.focus()
    setSearchQuery(editor, searchText(initialQuery))
    return () => setSearchQuery(editor, '')
  }, [editor, initialQuery])

  function choose(entry: BulletEntry) {
    setZoom(editor, entry.id)
    selectBullet(editor, entry.id)
    onClose()
  }

  function chooseCommand(command: SearchCommand) {
    onClose()
    command.run()
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Escape') onClose()
    else if (event.key === 'ArrowDown' && resultCount) {
      event.preventDefault(); setActive((index) => (index + 1) % resultCount)
    } else if (event.key === 'ArrowUp' && resultCount) {
      event.preventDefault(); setActive((index) => (index - 1 + resultCount) % resultCount)
    } else if (event.key === 'Enter') {
      const command = matchingCommands[active]
      const entry = results[active - matchingCommands.length]
      if (command || entry) {
        event.preventDefault()
        if (command) chooseCommand(command)
        else choose(entry)
      }
    }
  }

  function changeQuery(value: string) {
    setQuery(value)
    setActive(0)
    setSearchQuery(editor, searchText(value))
  }

  return (
    <div
      className={`search-backdrop t-backdrop ${motionState}`}
      aria-hidden={motionState === 'is-closing' || undefined}
      inert={motionState === 'is-closing' || undefined}
      onMouseDown={onClose}
    >
      <section
        className={`outline-search t-modal ${motionState}`}
        role={motionState === 'is-closing' ? undefined : 'dialog'}
        aria-modal={motionState === 'is-closing' ? undefined : 'true'}
        aria-label="Search outline"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="search-input-row">
          <SearchInput
            className="search-dialog-input h-12! border-0! bg-transparent! pl-10! text-[17px]! shadow-none!"
            ref={inputRef}
            value={query}
            onValueChange={changeQuery}
            onClear={() => changeQuery('')}
            onKeyDown={handleKeyDown}
            placeholder="Search commands or bullets…"
            aria-label="Search commands and bullets"
            role="combobox"
            aria-expanded="true"
            shortcutHint="esc"
          />
        </div>
        <div className="search-options">
          <div className="search-status-filters" role="group" aria-label="Todo filters">
            {SEARCH_FILTERS.map((filter) => (
              <FilterChip
                key={filter.label}
                active={activeFilter === filter.token}
                onClick={() => changeQuery(withSearchFilter(query, filter.token))}
              >
                {filter.label}
              </FilterChip>
            ))}
          </div>
          <SaveSearchControl
            query={query}
            onSave={(label) => onSaveSearch(query.trim(), label, null)}
          />
        </div>
        <div className="search-body">
          <SearchCommands commands={matchingCommands} active={active} onChoose={chooseCommand} />
          <SearchResults
            entries={results}
            allEntries={allEntries}
            query={query}
            active={active - matchingCommands.length}
            hasCommands={matchingCommands.length > 0}
            onChoose={choose}
          />
        </div>
        <footer className="search-footer" aria-hidden="true">
          <span><Kbd>up/down</Kbd> navigate</span>
          <span><Kbd>enter</Kbd> open</span>
          <span><Kbd>esc</Kbd> close</span>
        </footer>
      </section>
    </div>
  )
}

function useNodeMenu(editor: Editor | null, active: boolean) {
  const [request, setRequest] = useState<NodeMenuRequest | null>(null)
  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent<NodeMenuRequest>).detail
      if (editor && ownsPaneEvent(editor, detail, active)) setRequest(detail)
    }
    window.addEventListener(OUTLINER_NODE_MENU_EVENT, open)
    return () => window.removeEventListener(OUTLINER_NODE_MENU_EVENT, open)
  }, [editor, active])
  return [request, setRequest] as const
}

function useDeepLinks(editor: Editor | null) {
  useEffect(() => {
    if (!editor || editorPaneId(editor)) return
    const openHash = () => {
      const nodeId = new URLSearchParams(window.location.hash.slice(1)).get('node')
      if (!nodeId || !collectBullets(editor.state.doc).some((entry) => entry.id === nodeId)) return
      setZoom(editor, nodeId)
      selectBullet(editor, nodeId)
    }
    openHash()
    window.addEventListener('hashchange', openHash)
    return () => window.removeEventListener('hashchange', openHash)
  }, [editor])
}

export function OutlinerChrome({
  editor,
  paneActions,
  active = true,
  globalTarget = active,
  trash,
  onTrashChange,
  shortcuts = [],
  onShortcutsChange = () => undefined,
  onOpenSettings = () => undefined,
  onOpenTrash = () => undefined,
  onOpenInbox = () => undefined,
  onOpenDailyNotes = () => undefined,
  onOpenTasks = () => undefined,
}: {
  editor: Editor | null
  paneActions?: React.ReactNode
  active?: boolean
  globalTarget?: boolean
  trash: TrashEntry[]
  onTrashChange: (entries: TrashEntry[]) => void
  shortcuts?: OutlineShortcut[]
  onShortcutsChange?: (shortcuts: OutlineShortcut[]) => void
  sidebarCollapsed?: boolean
  onToggleSidebar?: () => void
  activitySidebarCollapsed?: boolean
  onToggleActivitySidebar?: () => void
  onOpenSettings?: () => void
  onOpenTrash?: () => void
  onOpenInbox?: () => void
  onOpenDailyNotes?: () => void
  onOpenTasks?: () => void
}) {
  const editorUi = useEditorUi(editor)
  const zoomId = editorUi?.zoomId ?? null
  const canNavigateBack = Boolean(editorUi?.backStack.length)
  const canNavigateForward = Boolean(editorUi?.forwardStack.length)
  const [searchOpen, setSearchOpen] = useState(false)
  const searchPresence = useMotionPresence(searchOpen, 150)
  const [searchQuery, setSearchQueryText] = useState('')
  const [searchSession, setSearchSession] = useState(0)
  const [nodeMenu, setNodeMenu] = useNodeMenu(editor, active)
  const [actionError, setActionError] = useState<string | null>(null)

  // Zooming opens a new page: start it at the top. Keeping the old scroll
  // offset left a link clicked low on a long page looking at empty space.
  useEffect(() => {
    if (editor && editorPaneId(editor)) return
    document.querySelector<HTMLElement>('.outline-workspace')?.scrollTo?.({ top: 0 })
  }, [editor, zoomId])
  useEffect(() => {
    if (!active) { setSearchOpen(false); setNodeMenu(null) }
  }, [active, setNodeMenu])
  useDeepLinks(editor)

  const openMoveForCurrentBullet = useCallback(() => {
    if (!editor || document.querySelector('[role="dialog"]')) return
    const nodeId = currentBulletId(editor)
    if (!nodeId) return
    const decision = validateSystemNodeAction(editor.state.doc, 'move', nodeId)
    if (!decision.allowed) {
      setActionError(decision.message)
      return
    }
    setNodeMenu({ nodeId, top: 0, left: 0, moveImmediately: true })
  }, [editor, setNodeMenu])

  function openSearch(query = '') {
    setSearchQueryText(query)
    setSearchSession((current) => current + 1)
    setSearchOpen(true)
  }

  function saveSearch(query: string, label: string, scopeId: string | null) {
    const duplicate = shortcuts.some((item) => item.type === 'search'
      && item.target === query && item.scopeId === scopeId)
    if (duplicate) {
      setActionError('That search is already saved in the sidebar.')
      return
    }
    onShortcutsChange([...shortcuts, { type: 'search', target: query, label, scopeId }])
  }

  function toggleNodeShortcut(nodeId: string) {
    const pinned = shortcuts.some((item) => item.type === 'node' && item.target === nodeId)
    onShortcutsChange(pinned
      ? shortcuts.filter((item) => item.type !== 'node' || item.target !== nodeId)
      : [...shortcuts, { type: 'node', target: nodeId }])
  }

  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (!globalTarget || event.isComposing || event.defaultPrevented) return
      if (!(event.metaKey || event.ctrlKey)) return
      if (event.key.toLocaleLowerCase() === 'k') {
        event.preventDefault()
        openSearch()
      } else if (event.key.toLocaleLowerCase() === 'm' && !event.altKey && !event.shiftKey) {
        event.preventDefault()
        openMoveForCurrentBullet()
      } else if (editor && event.key === '[') {
        event.preventDefault()
        navigateBack(editor)
      } else if (editor && event.key === ']') {
        event.preventDefault()
        navigateForward(editor)
      }
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [editor, globalTarget, openMoveForCurrentBullet])

  useEffect(() => {
    if (!editor || !globalTarget || !('__TAURI_INTERNALS__' in window)) return
    let disposed = false
    let unlisten: (() => void) | undefined
    void import('@tauri-apps/api/event')
      .then(({ listen }) => listen('forage-move-current-bullet', openMoveForCurrentBullet))
      .then((stopListening) => {
        if (disposed) stopListening()
        else unlisten = stopListening
      })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [editor, globalTarget, openMoveForCurrentBullet])

  useEffect(() => {
    const openSavedSearch = (event: Event) => {
      if (!editor) return
      const detail = (event as CustomEvent<SearchRequest>).detail
      if (!ownsPaneEvent(editor, detail, globalTarget)) return
      const { query } = detail
      openSearch(query)
    }
    window.addEventListener(OUTLINER_OPEN_SEARCH_EVENT, openSavedSearch)
    return () => window.removeEventListener(OUTLINER_OPEN_SEARCH_EVENT, openSavedSearch)
  }, [editor, globalTarget])

  useEffect(() => {
    const openDailyDate = (event: Event) => {
      if (!editor) return
      const detail = (event as CustomEvent<DailyDateRequest>).detail
      if (!ownsPaneEvent(editor, detail, active)) return
      const { date } = detail
      openOrCreateDailyNote(editor, {
        date,
        nextId: newNodeId,
        locale: typeof navigator === 'undefined' ? undefined : navigator.language,
      })
    }
    window.addEventListener(OUTLINER_DAILY_DATE_EVENT, openDailyDate)
    return () => window.removeEventListener(OUTLINER_DAILY_DATE_EVENT, openDailyDate)
  }, [editor, active])

  useEffect(() => {
    const openTag = (event: Event) => {
      const detail = (event as CustomEvent<{ tag?: string; sourcePaneId?: string }>).detail
      if (!editor || !ownsPaneEvent(editor, detail, active)) return
      const tag = detail?.tag
      if (tag) openSearch(`#${tag}`)
    }
    window.addEventListener(OUTLINE_TAG_EVENT, openTag)
    return () => window.removeEventListener(OUTLINE_TAG_EVENT, openTag)
  }, [editor, active])

  useEffect(() => {
    const openInternalLink = (event: Event) => {
      if (!editor || editorPaneId(editor)) return
      const targetId = (event as CustomEvent<{ targetId?: string }>).detail?.targetId
      if (!targetId || !collectBullets(editor.state.doc).some((entry) => entry.id === targetId)) return
      setZoom(editor, targetId)
      selectBullet(editor, targetId)
    }
    window.addEventListener(OUTLINE_INTERNAL_LINK_EVENT, openInternalLink)
    return () => window.removeEventListener(OUTLINE_INTERNAL_LINK_EVENT, openInternalLink)
  }, [editor])

  if (!editor) return null
  return (
    <>
      <Toolbar
        editor={editor}
        paneActions={paneActions}
        zoomId={zoomId}
        canNavigateBack={canNavigateBack}
        canNavigateForward={canNavigateForward}
        onNavigateBack={() => navigateBack(editor)}
        onNavigateForward={() => navigateForward(editor)}
      />
      {actionError && <div className="action-error" role="alert">{actionError}<button onClick={() => setActionError(null)}>Dismiss</button></div>}
      {searchPresence.mounted && createPortal(
        <OutlineSearch
          key={searchSession}
          editor={editor}
          initialQuery={searchQuery}
          onSaveSearch={saveSearch}
          onOpenHome={() => {
            setZoom(editor, null)
            editor.commands.focus()
          }}
          onOpenInbox={onOpenInbox}
          onOpenDailyNotes={onOpenDailyNotes}
          onOpenTasks={onOpenTasks}
          onOpenSettings={onOpenSettings}
          onOpenTrash={onOpenTrash}
          onClose={() => setSearchOpen(false)}
          motionState={searchPresence.motionState}
        />,
        document.body,
      )}
      {nodeMenu && (
        <NodeActions
          editor={editor}
          request={nodeMenu}
          onClose={() => setNodeMenu(null)}
          onTrashed={(entry) => onTrashChange([entry, ...trash])}
          onError={setActionError}
          isShortcut={shortcuts.some((item) => item.type === 'node' && item.target === nodeMenu.nodeId)}
          onToggleShortcut={() => toggleNodeShortcut(nodeMenu.nodeId)}
          onOpenRight={() => { requestInternalNavigation(editor, nodeMenu.nodeId, true); setNodeMenu(null) }}
        />
      )}
    </>
  )
}
