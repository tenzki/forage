import { useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  BookmarkPlus,
  Eye,
  EyeOff,
  Home,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Search,
  Settings,
  Trash2,
} from 'lucide-react'
import type { Editor } from '@tiptap/react'
import {
  breadcrumbFor,
  collectBullets,
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
  OUTLINER_NODE_MENU_EVENT,
  OUTLINER_OPEN_SEARCH_EVENT,
  setHideCompleted,
  setSearchQuery,
  setZoom,
  type NodeMenuRequest,
  type SearchRequest,
} from '../../editor/outlinerUi'
import { OUTLINE_INTERNAL_LINK_EVENT } from '../../editor/internalLinks'
import { OUTLINE_TAG_EVENT } from '../../editor/tags'
import type { OutlineShortcut, TrashEntry } from '../../types/tree'
import { NodeActions } from './NodeActions'

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
          <span aria-hidden="true">›</span>
          <button onClick={() => setZoom(editor, entry.id)}>{displayText(entry)}</button>
        </span>
      ))}
    </nav>
  )
}

function Toolbar({
  editor,
  zoomId,
  sidebarCollapsed,
  hideCompleted,
  canNavigateBack,
  canNavigateForward,
  onToggleSidebar,
  onNavigateBack,
  onNavigateForward,
  onToggleCompleted,
  onOpenSearch,
  activitySidebarCollapsed,
  onToggleActivitySidebar,
}: {
  editor: Editor
  zoomId: string | null
  sidebarCollapsed: boolean
  hideCompleted: boolean
  canNavigateBack: boolean
  canNavigateForward: boolean
  onToggleSidebar: () => void
  onNavigateBack: () => void
  onNavigateForward: () => void
  onToggleCompleted: () => void
  onOpenSearch: () => void
  activitySidebarCollapsed: boolean
  onToggleActivitySidebar: () => void
}) {
  return (
    <div className="outline-toolbar">
      <div className="outline-toolbar-navigation">
        <button
          className="outline-sidebar-toggle"
          aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={onToggleSidebar}
        >
          {sidebarCollapsed
            ? <PanelLeftOpen size={17} aria-hidden="true" />
            : <PanelLeftClose size={17} aria-hidden="true" />}
        </button>
        <div className="outline-history-navigation" aria-label="Navigation history">
          <button
            aria-label="Go back"
            title="Back (⌘[ / Ctrl+[)"
            aria-keyshortcuts="Meta+[ Control+["
            disabled={!canNavigateBack}
            onClick={onNavigateBack}
          >
            <ArrowLeft size={16} aria-hidden="true" />
          </button>
          <button
            aria-label="Go forward"
            title="Forward (⌘] / Ctrl+])"
            aria-keyshortcuts="Meta+] Control+]"
            disabled={!canNavigateForward}
            onClick={onNavigateForward}
          >
            <ArrowRight size={16} aria-hidden="true" />
          </button>
        </div>
        <Breadcrumbs editor={editor} zoomId={zoomId} />
      </div>
      <div className="outline-toolbar-actions">
        <button className="completed-visibility" onClick={onToggleCompleted}>
          {hideCompleted
            ? <Eye size={15} aria-hidden="true" />
            : <EyeOff size={15} aria-hidden="true" />}
          {hideCompleted ? 'Show completed' : 'Hide completed'}
        </button>
        <button className="search-open" onClick={onOpenSearch} aria-keyshortcuts="Meta+K Control+K">
          <Search size={15} aria-hidden="true" /> Search <kbd>⌘K</kbd>
        </button>
        <button
          className="outline-sidebar-toggle activity-toolbar-toggle"
          aria-label={activitySidebarCollapsed ? 'Expand activity sidebar' : 'Collapse activity sidebar'}
          onClick={onToggleActivitySidebar}
        >
          {activitySidebarCollapsed
            ? <PanelRightOpen size={17} aria-hidden="true" />
            : <PanelRightClose size={17} aria-hidden="true" />}
        </button>
      </div>
    </div>
  )
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
        <span className="search-result-title">{displayText(entry)}</span>
        <small>
          {entry.noteText ? `${path || 'Home'} · Note: ${entry.noteText}` : (path || 'Home')}
        </small>
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
  id: 'home' | 'settings' | 'trash'
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
    <ul className="search-commands" aria-label="Commands">
      {commands.map((command, index) => (
        <li key={command.id} className={index === active ? 'active' : ''}>
          <button onMouseDown={(event) => event.preventDefault()} onClick={() => onChoose(command)}>
            {command.id === 'home' && <Home size={17} aria-hidden="true" />}
            {command.id === 'settings' && <Settings size={17} aria-hidden="true" />}
            {command.id === 'trash' && <Trash2 size={17} aria-hidden="true" />}
            <span><strong>{command.label}</strong><small>{command.description}</small></span>
            <span className="search-command-open">Open</span>
          </button>
        </li>
      ))}
    </ul>
  )
}

function OutlineSearch({
  editor,
  initialQuery,
  onSaveSearch,
  onOpenHome,
  onOpenSettings,
  onOpenTrash,
  onClose,
}: {
  editor: Editor
  initialQuery: string
  onSaveSearch: (query: string, label: string, scopeId: string | null) => void
  onOpenHome: () => void
  onOpenSettings: () => void
  onOpenTrash: () => void
  onClose: () => void
}) {
  const [query, setQuery] = useState(initialQuery)
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const allEntries = collectBullets(editor.state.doc)
  const results = query.trim() ? searchBullets(allEntries, query) : []
  const commands: SearchCommand[] = [
    { id: 'home', label: 'Home', description: 'Return to the full outline', run: onOpenHome },
    { id: 'settings', label: 'Settings', description: 'Configure connections, agents, and tools', run: onOpenSettings },
    { id: 'trash', label: 'Trash', description: 'Review and restore deleted items', run: onOpenTrash },
  ]
  const commandTerms = normalizeSearchText(searchText(query)).trim().split(/\s+/u).filter(Boolean)
  const matchingCommands = commands.filter((command) => {
    const text = normalizeSearchText(`${command.label} ${command.description}`)
    return commandTerms.every((term) => text.includes(term))
  })
  const resultCount = matchingCommands.length + results.length

  useEffect(() => {
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
    <div className="search-backdrop" onMouseDown={onClose}>
      <section className="outline-search" role="dialog" aria-modal="true" aria-label="Search outline" onMouseDown={(event) => event.stopPropagation()}>
        <div className="search-input-row">
          <span aria-hidden="true">⌕</span>
          <input ref={inputRef} value={query} onChange={(event) => changeQuery(event.target.value)} onKeyDown={handleKeyDown} placeholder="Search commands or bullets…" aria-label="Search commands and bullets" role="combobox" aria-expanded="true" />
          <kbd>esc</kbd>
        </div>
        <div className="search-options">
          <div className="search-status-filters" aria-label="Todo filters">
            <button onClick={() => changeQuery('is:todo')}>Todos</button>
            <button onClick={() => changeQuery('is:open')}>Open</button>
            <button onClick={() => changeQuery('is:complete')}>Completed</button>
          </div>
          <SaveSearchControl
            query={query}
            onSave={(label) => onSaveSearch(query.trim(), label, null)}
          />
        </div>
        <SearchCommands commands={matchingCommands} active={active} onChoose={chooseCommand} />
        <SearchResults
          entries={results}
          allEntries={allEntries}
          query={query}
          active={active - matchingCommands.length}
          hasCommands={matchingCommands.length > 0}
          onChoose={choose}
        />
      </section>
    </div>
  )
}

function useNodeMenu() {
  const [request, setRequest] = useState<NodeMenuRequest | null>(null)
  useEffect(() => {
    const open = (event: Event) => setRequest((event as CustomEvent<NodeMenuRequest>).detail)
    window.addEventListener(OUTLINER_NODE_MENU_EVENT, open)
    return () => window.removeEventListener(OUTLINER_NODE_MENU_EVENT, open)
  }, [])
  return [request, setRequest] as const
}

function useDeepLinks(editor: Editor | null) {
  useEffect(() => {
    if (!editor) return
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
  trash,
  onTrashChange,
  shortcuts = [],
  onShortcutsChange = () => undefined,
  sidebarCollapsed = false,
  onToggleSidebar = () => undefined,
  activitySidebarCollapsed = false,
  onToggleActivitySidebar = () => undefined,
  onOpenSettings = () => undefined,
  onOpenTrash = () => undefined,
}: {
  editor: Editor | null
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
}) {
  const editorUi = useEditorUi(editor)
  const zoomId = editorUi?.zoomId ?? null
  const hideCompleted = editorUi?.hideCompleted ?? false
  const canNavigateBack = Boolean(editorUi?.backStack.length)
  const canNavigateForward = Boolean(editorUi?.forwardStack.length)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQueryText] = useState('')
  const [nodeMenu, setNodeMenu] = useNodeMenu()
  const [actionError, setActionError] = useState<string | null>(null)
  useDeepLinks(editor)

  function openSearch(query = '') {
    setSearchQueryText(query)
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
      if (!(event.metaKey || event.ctrlKey)) return
      if (event.key.toLocaleLowerCase() === 'k') {
        event.preventDefault()
        openSearch()
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
  }, [editor])

  useEffect(() => {
    const openSavedSearch = (event: Event) => {
      if (!editor) return
      const { query } = (event as CustomEvent<SearchRequest>).detail
      openSearch(query)
    }
    window.addEventListener(OUTLINER_OPEN_SEARCH_EVENT, openSavedSearch)
    return () => window.removeEventListener(OUTLINER_OPEN_SEARCH_EVENT, openSavedSearch)
  }, [editor])

  useEffect(() => {
    const openTag = (event: Event) => {
      const tag = (event as CustomEvent<{ tag?: string }>).detail?.tag
      if (tag) openSearch(`#${tag}`)
    }
    window.addEventListener(OUTLINE_TAG_EVENT, openTag)
    return () => window.removeEventListener(OUTLINE_TAG_EVENT, openTag)
  }, [])

  useEffect(() => {
    const openInternalLink = (event: Event) => {
      if (!editor) return
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
        zoomId={zoomId}
        sidebarCollapsed={sidebarCollapsed}
        hideCompleted={hideCompleted}
        canNavigateBack={canNavigateBack}
        canNavigateForward={canNavigateForward}
        onToggleSidebar={onToggleSidebar}
        activitySidebarCollapsed={activitySidebarCollapsed}
        onToggleActivitySidebar={onToggleActivitySidebar}
        onNavigateBack={() => navigateBack(editor)}
        onNavigateForward={() => navigateForward(editor)}
        onToggleCompleted={() => setHideCompleted(editor, !hideCompleted)}
        onOpenSearch={() => openSearch()}
      />
      {actionError && <div className="action-error" role="alert">{actionError}<button onClick={() => setActionError(null)}>Dismiss</button></div>}
      {searchOpen && (
        <OutlineSearch
          editor={editor}
          initialQuery={searchQuery}
          onSaveSearch={saveSearch}
          onOpenHome={() => {
            setZoom(editor, null)
            editor.commands.focus()
          }}
          onOpenSettings={onOpenSettings}
          onOpenTrash={onOpenTrash}
          onClose={() => setSearchOpen(false)}
        />
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
        />
      )}
    </>
  )
}
