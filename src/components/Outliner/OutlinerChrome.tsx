import { useEffect, useMemo, useRef, useState } from 'react'
import { BookmarkPlus, Eye, EyeOff, PanelLeftClose, PanelLeftOpen, Search } from 'lucide-react'
import type { Editor } from '@tiptap/react'
import {
  breadcrumbFor,
  collectBullets,
  searchBullets,
  searchText,
  selectBullet,
  updateBulletText,
  type BulletEntry,
} from '../../editor/outlineModel'
import {
  getOutlinerUiState,
  OUTLINER_NODE_MENU_EVENT,
  OUTLINER_OPEN_SEARCH_EVENT,
  setHideCompleted,
  setSearchQuery,
  setZoom,
  type NodeMenuRequest,
  type SearchRequest,
} from '../../editor/outlinerUi'
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
  onToggleSidebar,
  onToggleCompleted,
  onOpenSearch,
}: {
  editor: Editor
  zoomId: string | null
  sidebarCollapsed: boolean
  hideCompleted: boolean
  onToggleSidebar: () => void
  onToggleCompleted: () => void
  onOpenSearch: () => void
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
  editor,
  entry,
  path,
  active,
  onChoose,
}: {
  editor: Editor
  entry: BulletEntry
  path: string
  active: boolean
  onChoose: () => void
}) {
  const [draft, setDraft] = useState(entry.text)

  function save() {
    if (draft !== entry.text) updateBulletText(editor, entry.id, draft)
  }

  return (
    <li className={active ? 'search-result active' : 'search-result'}>
      <input
        aria-label={`Edit ${displayText(entry)}`}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={save}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur()
          if (event.key === 'Escape') setDraft(entry.text)
        }}
      />
      <small>
        {entry.noteText ? `${path || 'Home'} · Note: ${entry.noteText}` : (path || 'Home')}
      </small>
      <button onMouseDown={(event) => event.preventDefault()} onClick={onChoose}>Open</button>
    </li>
  )
}

function SearchResults({
  editor,
  entries,
  allEntries,
  query,
  active,
  onChoose,
}: {
  editor: Editor
  entries: BulletEntry[]
  allEntries: BulletEntry[]
  query: string
  active: number
  onChoose: (entry: BulletEntry) => void
}) {
  if (!query.trim()) return <p className="search-empty">Type to search your outline.</p>
  if (!entries.length) return <p className="search-empty">No matching bullets.</p>
  return (
    <ul className="search-results" aria-label="Matching bullets">
      {entries.map((entry, index) => (
        <SearchResultRow
          key={entry.id}
          editor={editor}
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

function OutlineSearch({
  editor,
  zoomId,
  initialQuery,
  onSaveSearch,
  onClose,
}: {
  editor: Editor
  zoomId: string | null
  initialQuery: string
  onSaveSearch: (query: string, label: string, scopeId: string | null) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState(initialQuery)
  const [allOutline, setAllOutline] = useState(!zoomId)
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const allEntries = collectBullets(editor.state.doc)
  const results = useMemo(() => {
    const scoped = allOutline || !zoomId
      ? allEntries
      : allEntries.filter((entry) => entry.id === zoomId || entry.ancestorIds.includes(zoomId))
    return query.trim() ? searchBullets(scoped, query) : []
  }, [allEntries, allOutline, query, zoomId])

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

  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Escape') onClose()
    else if (event.key === 'ArrowDown' && results.length) {
      event.preventDefault(); setActive((index) => (index + 1) % results.length)
    } else if (event.key === 'ArrowUp' && results.length) {
      event.preventDefault(); setActive((index) => (index - 1 + results.length) % results.length)
    } else if (event.key === 'Enter' && results[active]) {
      event.preventDefault(); choose(results[active])
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
          <input ref={inputRef} value={query} onChange={(event) => changeQuery(event.target.value)} onKeyDown={handleKeyDown} placeholder="Search bullets…" aria-label="Search bullets" role="combobox" aria-expanded="true" />
          <kbd>esc</kbd>
        </div>
        <div className="search-options">
          {zoomId && (
            <label className="search-scope">
              <input type="checkbox" checked={allOutline} onChange={(event) => setAllOutline(event.target.checked)} />
              Search all outline
            </label>
          )}
          <div className="search-status-filters" aria-label="Todo filters">
            <button onClick={() => changeQuery('is:todo')}>Todos</button>
            <button onClick={() => changeQuery('is:open')}>Open</button>
            <button onClick={() => changeQuery('is:complete')}>Completed</button>
          </div>
          <SaveSearchControl
            query={query}
            onSave={(label) => onSaveSearch(query.trim(), label, allOutline ? null : zoomId)}
          />
        </div>
        <SearchResults editor={editor} entries={results} allEntries={allEntries} query={query} active={active} onChoose={choose} />
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
}: {
  editor: Editor | null
  trash: TrashEntry[]
  onTrashChange: (entries: TrashEntry[]) => void
  shortcuts?: OutlineShortcut[]
  onShortcutsChange?: (shortcuts: OutlineShortcut[]) => void
  sidebarCollapsed?: boolean
  onToggleSidebar?: () => void
}) {
  const editorUi = useEditorUi(editor)
  const zoomId = editorUi?.zoomId ?? null
  const hideCompleted = editorUi?.hideCompleted ?? false
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
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'k') {
        event.preventDefault()
        openSearch()
      }
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [])

  useEffect(() => {
    const openSavedSearch = (event: Event) => {
      if (!editor) return
      const { query, scopeId } = (event as CustomEvent<SearchRequest>).detail
      const validScope = scopeId && collectBullets(editor.state.doc).some((entry) => entry.id === scopeId)
      setZoom(editor, validScope ? scopeId : null)
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

  if (!editor) return null
  return (
    <>
      <Toolbar
        editor={editor}
        zoomId={zoomId}
        sidebarCollapsed={sidebarCollapsed}
        hideCompleted={hideCompleted}
        onToggleSidebar={onToggleSidebar}
        onToggleCompleted={() => setHideCompleted(editor, !hideCompleted)}
        onOpenSearch={() => openSearch()}
      />
      {actionError && <div className="action-error" role="alert">{actionError}<button onClick={() => setActionError(null)}>Dismiss</button></div>}
      {searchOpen && (
        <OutlineSearch
          editor={editor}
          zoomId={zoomId}
          initialQuery={searchQuery}
          onSaveSearch={saveSearch}
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
