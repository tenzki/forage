import { useEffect, useMemo, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import {
  breadcrumbFor,
  collectBullets,
  selectBullet,
  type BulletEntry,
} from '../../editor/outlineModel'
import {
  getOutlinerUiState,
  setSearchQuery,
  setZoom,
} from '../../editor/outlinerUi'
import { OUTLINE_TAG_EVENT } from '../../editor/tags'

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
  const ui = editor ? getOutlinerUiState(editor) : { zoomId: null, query: '' }
  return ui.zoomId
}

function Breadcrumbs({ editor, zoomId }: { editor: Editor; zoomId: string | null }) {
  const path = breadcrumbFor(editor.state.doc, zoomId)
  return (
    <nav className="outline-breadcrumbs" aria-label="Outline location">
      <button className="breadcrumb-home" onClick={() => setZoom(editor, null)}>
        Home
      </button>
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
  onOpenSearch,
}: {
  editor: Editor
  zoomId: string | null
  onOpenSearch: () => void
}) {
  return (
    <div className="outline-toolbar">
      <Breadcrumbs editor={editor} zoomId={zoomId} />
      <button className="search-open" onClick={onOpenSearch} aria-keyshortcuts="Meta+K Control+K">
        <span aria-hidden="true">⌕</span> Search <kbd>⌘K</kbd>
      </button>
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

function SearchResults({
  entries,
  allEntries,
  query,
  active,
  onChoose,
}: {
  entries: BulletEntry[]
  allEntries: BulletEntry[]
  query: string
  active: number
  onChoose: (entry: BulletEntry) => void
}) {
  if (!query.trim()) return <p className="search-empty">Type to search your outline.</p>
  if (!entries.length) return <p className="search-empty">No matching bullets.</p>
  return (
    <ul className="search-results" role="listbox">
      {entries.map((entry, index) => (
        <li key={entry.id}>
          <button
            className={index === active ? 'search-result active' : 'search-result'}
            role="option"
            aria-selected={index === active}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onChoose(entry)}
          >
            <span>{displayText(entry)}</span>
            <small>{resultPath(entry, allEntries) || 'Home'}</small>
          </button>
        </li>
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

  function changeQuery(value: string) {
    setQuery(value)
    setActive(0)
    setSearchQuery(editor, value)
  }

  function choose(entry: BulletEntry) {
    setZoom(editor, entry.id)
    selectBullet(editor, entry.id)
    onClose()
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Escape') onClose()
    else if (event.key === 'ArrowDown' && results.length) {
      event.preventDefault()
      setActive((index) => (index + 1) % results.length)
    } else if (event.key === 'ArrowUp' && results.length) {
      event.preventDefault()
      setActive((index) => (index - 1 + results.length) % results.length)
    } else if (event.key === 'Enter' && results[active]) {
      event.preventDefault()
      choose(results[active])
    }
  }

  return (
    <div className="search-backdrop" onMouseDown={onClose}>
      <section
        className="outline-search"
        role="dialog"
        aria-modal="true"
        aria-label="Search outline"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="search-input-row">
          <span aria-hidden="true">⌕</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => changeQuery(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search bullets…"
            aria-label="Search bullets"
            role="combobox"
            aria-expanded="true"
          />
          <kbd>esc</kbd>
        </div>
        {zoomId && (
          <label className="search-scope">
            <input
              type="checkbox"
              checked={allOutline}
              onChange={(event) => setAllOutline(event.target.checked)}
            />
            Search all outline
          </label>
        )}
        <SearchResults
          entries={results}
          allEntries={allEntries}
          query={query}
          active={active}
          onChoose={choose}
        />
      </section>
    </div>
  )
}

export function OutlinerChrome({ editor }: { editor: Editor | null }) {
  const zoomId = useEditorUi(editor)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQueryText] = useState('')

  function openSearch(query = '') {
    setSearchQueryText(query)
    setSearchOpen(true)
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
      <Toolbar editor={editor} zoomId={zoomId} onOpenSearch={() => openSearch()} />
      {searchOpen && (
        <OutlineSearch
          editor={editor}
          zoomId={zoomId}
          initialQuery={searchQuery}
          onClose={() => setSearchOpen(false)}
        />
      )}
    </>
  )
}
