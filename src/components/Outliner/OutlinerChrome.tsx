import { useEffect, useMemo, useRef, useState } from 'react'
import { PanelLeftClose, PanelLeftOpen, Search } from 'lucide-react'
import type { Editor } from '@tiptap/react'
import {
  breadcrumbFor,
  collectBullets,
  selectBullet,
  updateBulletText,
  type BulletEntry,
} from '../../editor/outlineModel'
import {
  getOutlinerUiState,
  OUTLINER_NODE_MENU_EVENT,
  OUTLINER_OPEN_TRASH_EVENT,
  setSearchQuery,
  setZoom,
  type NodeMenuRequest,
} from '../../editor/outlinerUi'
import { OUTLINE_TAG_EVENT } from '../../editor/tags'
import type { OutlineShortcut, TrashEntry } from '../../types/tree'
import { NodeActions } from './NodeActions'
import { TrashPanel } from './TrashPanel'

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
  return editor ? getOutlinerUiState(editor).zoomId : null
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
  onToggleSidebar,
  onOpenSearch,
}: {
  editor: Editor
  zoomId: string | null
  sidebarCollapsed: boolean
  onToggleSidebar: () => void
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
      <small>{path || 'Home'}</small>
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

function OutlineSearch({
  editor,
  zoomId,
  initialQuery,
  onClose,
}: {
  editor: Editor
  zoomId: string | null
  initialQuery: string
  onClose: () => void
}) {
  const [query, setQuery] = useState(initialQuery)
  const [allOutline, setAllOutline] = useState(!zoomId)
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const allEntries = collectBullets(editor.state.doc)
  const results = useMemo(() => {
    const term = query.trim().toLocaleLowerCase()
    const scoped = allOutline || !zoomId
      ? allEntries
      : allEntries.filter((entry) => entry.id === zoomId || entry.ancestorIds.includes(zoomId))
    return term ? scoped.filter((entry) => entry.text.toLocaleLowerCase().includes(term)) : []
  }, [allEntries, allOutline, query, zoomId])

  useEffect(() => {
    inputRef.current?.focus()
    setSearchQuery(editor, initialQuery)
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
    setSearchQuery(editor, value)
  }

  return (
    <div className="search-backdrop" onMouseDown={onClose}>
      <section className="outline-search" role="dialog" aria-modal="true" aria-label="Search outline" onMouseDown={(event) => event.stopPropagation()}>
        <div className="search-input-row">
          <span aria-hidden="true">⌕</span>
          <input ref={inputRef} value={query} onChange={(event) => changeQuery(event.target.value)} onKeyDown={handleKeyDown} placeholder="Search bullets…" aria-label="Search bullets" role="combobox" aria-expanded="true" />
          <kbd>esc</kbd>
        </div>
        {zoomId && (
          <label className="search-scope">
            <input type="checkbox" checked={allOutline} onChange={(event) => setAllOutline(event.target.checked)} />
            Search all outline
          </label>
        )}
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
  const zoomId = useEditorUi(editor)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQueryText] = useState('')
  const [trashOpen, setTrashOpen] = useState(false)
  const [nodeMenu, setNodeMenu] = useNodeMenu()
  const [actionError, setActionError] = useState<string | null>(null)
  useDeepLinks(editor)

  function openSearch(query = '') {
    setSearchQueryText(query)
    setSearchOpen(true)
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
    const openTrash = () => setTrashOpen(true)
    window.addEventListener(OUTLINER_OPEN_TRASH_EVENT, openTrash)
    return () => window.removeEventListener(OUTLINER_OPEN_TRASH_EVENT, openTrash)
  }, [])

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
        onToggleSidebar={onToggleSidebar}
        onOpenSearch={() => openSearch()}
      />
      {actionError && <div className="action-error" role="alert">{actionError}<button onClick={() => setActionError(null)}>Dismiss</button></div>}
      {searchOpen && (
        <OutlineSearch
          editor={editor}
          zoomId={zoomId}
          initialQuery={searchQuery}
          onClose={() => setSearchOpen(false)}
        />
      )}
      {trashOpen && <TrashPanel editor={editor} entries={trash} onChange={onTrashChange} onError={setActionError} onClose={() => setTrashOpen(false)} />}
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
