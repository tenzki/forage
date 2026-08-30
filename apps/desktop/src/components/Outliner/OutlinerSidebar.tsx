import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Circle,
  GripVertical,
  Hash,
  Home,
  Plus,
  Search as SearchIcon,
  Settings as SettingsIcon,
  Trash2,
  X,
} from 'lucide-react'
import type { Editor } from '@tiptap/react'
import { collectBullets, selectBullet, type BulletEntry } from '../../editor/outlineModel'
import {
  OUTLINER_OPEN_SEARCH_EVENT,
  OUTLINER_POINTER_DRAG_EVENT,
  setZoom,
  type PointerDragEventDetail,
} from '../../editor/outlinerUi'
import { collectTags, OUTLINE_TAG_EVENT } from '../../editor/tags'
import type { OutlineShortcut } from '../../types/tree'

interface OutlinerSidebarProps {
  editor: Editor | null
  shortcuts: OutlineShortcut[]
  collapsed?: boolean
  trashCount?: number
  activeView?: 'outliner' | 'settings' | 'trash'
  onChange: (shortcuts: OutlineShortcut[]) => void
  onOpenOutline?: () => void
  onOpenSettings?: () => void
  onOpenTrash?: () => void
}

interface ShortcutDragGhost {
  label: string
  sourceIndex: number
  x: number
  y: number
}

interface ShortcutPickerProps {
  entries: BulletEntry[]
  tags: string[]
  shortcuts: OutlineShortcut[]
  onAdd: (shortcut: OutlineShortcut) => void
  onClose: () => void
}

function shortcutKey(shortcut: OutlineShortcut): string {
  return shortcut.type === 'search'
    ? `${shortcut.type}:${shortcut.scopeId ?? 'all'}:${shortcut.target}`
    : `${shortcut.type}:${shortcut.target}`
}

function ShortcutPicker({ entries, tags, shortcuts, onAdd, onClose }: ShortcutPickerProps) {
  const [query, setQuery] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const pinned = new Set(shortcuts.map(shortcutKey))
  const term = query.trim().toLocaleLowerCase()
  const candidates = [
    ...tags.map((tag) => ({ shortcut: { type: 'tag', target: tag } as OutlineShortcut, label: tag })),
    ...entries.map((entry) => ({
      shortcut: { type: 'node', target: entry.id } as OutlineShortcut,
      label: entry.text.trim() || 'Untitled',
    })),
  ].filter((item) => !pinned.has(shortcutKey(item.shortcut))
    && (!term || item.label.toLocaleLowerCase().includes(term)))

  useEffect(() => inputRef.current?.focus(), [])

  return (
    <section className="shortcut-picker" role="dialog" aria-label="Add shortcut">
      <div className="shortcut-picker-search">
        <input
          ref={inputRef}
          aria-label="Search nodes and tags"
          placeholder="Search nodes and tags…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Escape') onClose() }}
        />
        <button aria-label="Close shortcut search" onClick={onClose}><X size={15} /></button>
      </div>
      <ul>
        {candidates.slice(0, 30).map(({ shortcut, label }) => (
          <li key={shortcutKey(shortcut)}>
            <button
              aria-label={shortcut.type === 'tag' ? `#${shortcut.target}` : undefined}
              onClick={() => { onAdd(shortcut); onClose() }}
            >
              <span aria-hidden="true">{shortcut.type === 'tag' ? <Hash size={14} /> : <Circle size={9} />}</span>
              <span>{label}</span>
              <small>{shortcut.type === 'tag' ? 'Tag' : 'Node'}</small>
            </button>
          </li>
        ))}
      </ul>
      {!candidates.length && <p>No matching shortcuts.</p>}
    </section>
  )
}

export function OutlinerSidebar({
  editor,
  shortcuts,
  collapsed = false,
  trashCount = 0,
  activeView = 'outliner',
  onChange,
  onOpenOutline = () => undefined,
  onOpenSettings = () => undefined,
  onOpenTrash = () => undefined,
}: OutlinerSidebarProps) {
  const [, setRevision] = useState(0)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [shortcutGhost, setShortcutGhost] = useState<ShortcutDragGhost | null>(null)
  const sidebarRef = useRef<HTMLElement>(null)

  useEffect(() => {
    if (collapsed) setPickerOpen(false)
  }, [collapsed])

  useEffect(() => {
    if (!editor) return
    const update = () => setRevision((value) => value + 1)
    editor.on('transaction', update)
    return () => { editor.off('transaction', update) }
  }, [editor])

  const entries = editor ? collectBullets(editor.state.doc) : []
  const entriesById = useMemo(
    () => new Map(entries.map((entry) => [entry.id, entry])),
    [entries],
  )
  const tags = editor ? collectTags(editor.state.doc) : []

  function add(shortcut: OutlineShortcut) {
    if (shortcuts.some((item) => shortcutKey(item) === shortcutKey(shortcut))) return
    onChange([...shortcuts, shortcut])
  }

  useEffect(() => {
    const handleDrag = (event: Event) => {
      const detail = (event as CustomEvent<PointerDragEventDetail>).detail
      const rect = sidebarRef.current?.getBoundingClientRect()
      const inside = Boolean(rect
        && detail.clientX >= rect.left && detail.clientX <= rect.right
        && detail.clientY >= rect.top && detail.clientY <= rect.bottom)
      if (detail.phase === 'move') setDragOver(inside)
      else {
        setDragOver(false)
        if (detail.phase === 'drop' && inside) add({ type: 'node', target: detail.nodeId })
      }
    }
    window.addEventListener(OUTLINER_POINTER_DRAG_EVENT, handleDrag)
    return () => window.removeEventListener(OUTLINER_POINTER_DRAG_EVENT, handleDrag)
  }, [shortcuts])

  function remove(shortcut: OutlineShortcut) {
    const key = shortcutKey(shortcut)
    onChange(shortcuts.filter((item) => shortcutKey(item) !== key))
  }

  function open(shortcut: OutlineShortcut) {
    if (!editor) return
    onOpenOutline()
    if (shortcut.type === 'tag') {
      window.dispatchEvent(new CustomEvent(OUTLINE_TAG_EVENT, { detail: { tag: shortcut.target } }))
    } else if (shortcut.type === 'search') {
      window.dispatchEvent(new CustomEvent(OUTLINER_OPEN_SEARCH_EVENT, {
        detail: { query: shortcut.target, scopeId: shortcut.scopeId },
      }))
    } else if (entriesById.has(shortcut.target)) {
      setZoom(editor, shortcut.target)
      selectBullet(editor, shortcut.target)
    }
  }

  function startShortcutDrag(event: React.PointerEvent, sourceIndex: number, label: string) {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    const startX = event.clientX
    const startY = event.clientY
    let started = false
    let targetIndex: number | null = null
    let insertAfter = false
    let targetRow: HTMLElement | null = null

    const clearTarget = () => {
      targetRow?.removeAttribute('data-shortcut-drop')
      targetRow = null
    }
    const move = (pointerEvent: PointerEvent) => {
      if (!started && Math.hypot(pointerEvent.clientX - startX, pointerEvent.clientY - startY) < 4) return
      pointerEvent.preventDefault()
      started = true
      document.body.classList.add('is-dragging-shortcut')
      setShortcutGhost({ label, sourceIndex, x: pointerEvent.clientX, y: pointerEvent.clientY })
      const hit = document.elementFromPoint(pointerEvent.clientX, pointerEvent.clientY)
        ?.closest<HTMLElement>('.sidebar-shortcuts li[data-shortcut-index]') ?? null
      clearTarget()
      if (!hit) {
        targetIndex = null
        return
      }
      const rect = hit.getBoundingClientRect()
      targetIndex = Number(hit.dataset.shortcutIndex)
      insertAfter = pointerEvent.clientY > rect.top + rect.height / 2
      targetRow = hit
      hit.dataset.shortcutDrop = insertAfter ? 'after' : 'before'
    }
    const finish = (pointerEvent: PointerEvent, cancelled = false) => {
      if (started) pointerEvent.preventDefault()
      clearTarget()
      document.body.classList.remove('is-dragging-shortcut')
      setShortcutGhost(null)
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', finish)
      document.removeEventListener('pointercancel', cancel)
      if (cancelled || targetIndex === null) return
      const reordered = [...shortcuts]
      const [moved] = reordered.splice(sourceIndex, 1)
      let insertionIndex = targetIndex + (insertAfter ? 1 : 0)
      if (sourceIndex < insertionIndex) insertionIndex -= 1
      reordered.splice(insertionIndex, 0, moved)
      if (reordered.some((item, index) => item !== shortcuts[index])) onChange(reordered)
    }
    const cancel = (pointerEvent: PointerEvent) => finish(pointerEvent, true)
    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', finish)
    document.addEventListener('pointercancel', cancel)
  }

  return (
    <aside ref={sidebarRef} className={`outline-sidebar${collapsed ? ' is-collapsed' : ''}${dragOver ? ' is-drop-target' : ''}`} aria-label="Outline sidebar">
      <div className="sidebar-top-row">
        <button
          className={`sidebar-home${activeView === 'outliner' ? ' is-active' : ''}`}
          aria-current={activeView === 'outliner' ? 'page' : undefined}
          onClick={() => { onOpenOutline(); if (editor) setZoom(editor, null) }}
          title="Home"
        >
          <Home className="sidebar-primary-icon" aria-hidden="true" /><span className="sidebar-primary-label">Home</span>
        </button>
      </div>
      {!collapsed && (
        <div className="sidebar-shortcut-content">
          <div className="sidebar-section-heading">
            <h2>Shortcuts</h2>
            <button aria-label="Add shortcut" aria-expanded={pickerOpen} onClick={() => setPickerOpen((value) => !value)}><Plus size={16} /></button>
          </div>
          {pickerOpen && <ShortcutPicker entries={entries} tags={tags} shortcuts={shortcuts} onAdd={add} onClose={() => setPickerOpen(false)} />}
          {!shortcuts.length && <p className="sidebar-empty">Drag a node here or use + to add nodes and tags.</p>}
          <ul className="sidebar-shortcuts">
            {shortcuts.map((shortcut, index) => {
              const entry = shortcut.type === 'node' ? entriesById.get(shortcut.target) : null
              const missing = shortcut.type === 'node' && !entry
              const label = shortcut.type === 'tag'
                ? `#${shortcut.target}`
                : shortcut.type === 'search'
                  ? shortcut.label
                  : (entry?.text.trim() || 'Unavailable node')
              return (
                <li
                  key={shortcutKey(shortcut)}
                  data-shortcut-index={index}
                  className={shortcutGhost?.sourceIndex === index ? 'is-shortcut-drag-source' : ''}
                >
                  <button
                    className="sidebar-shortcut-open"
                    aria-label={shortcut.type === 'tag' ? `#${shortcut.target}` : undefined}
                    disabled={missing}
                    onClick={() => open(shortcut)}
                    title={label}
                  >
                    <span className="sidebar-shortcut-icon" aria-hidden="true">
                      {shortcut.type === 'tag'
                        ? <Hash size={13} />
                        : shortcut.type === 'search'
                          ? <SearchIcon size={13} />
                          : <Circle size={8} />}
                    </span>
                    <span>{shortcut.type === 'tag' ? shortcut.target : label}</span>
                  </button>
                  <button
                    className="sidebar-shortcut-drag"
                    aria-label={`Reorder ${label}`}
                    title="Drag to reorder"
                    onPointerDown={(event) => startShortcutDrag(event, index, label)}
                  >
                    <GripVertical size={14} aria-hidden="true" />
                  </button>
                  <button className="sidebar-shortcut-remove" aria-label={`Remove ${label} shortcut`} onClick={() => remove(shortcut)}>
                    <X size={13} aria-hidden="true" />
                  </button>
                </li>
              )
            })}
          </ul>
        </div>
      )}
      <nav className="sidebar-bottom" aria-label="Sidebar actions">
        <button
          className={`sidebar-settings${activeView === 'settings' ? ' is-active' : ''}`}
          aria-current={activeView === 'settings' ? 'page' : undefined}
          onClick={onOpenSettings}
          title="Settings"
        >
          <SettingsIcon className="sidebar-primary-icon" aria-hidden="true" />
          <span className="sidebar-primary-label">Settings</span>
        </button>
        <button
          className={`sidebar-trash${activeView === 'trash' ? ' is-active' : ''}`}
          aria-current={activeView === 'trash' ? 'page' : undefined}
          aria-label="Trash"
          onClick={onOpenTrash}
          title="Trash"
        >
          <Trash2 className="sidebar-primary-icon" aria-hidden="true" />
          <span className="sidebar-primary-label">Trash</span>
          {trashCount > 0 && <span className="sidebar-trash-count">{trashCount}</span>}
        </button>
      </nav>
      {dragOver && <div className="sidebar-drop-message">Drop to add shortcut</div>}
      {shortcutGhost && (
        <div
          className="sidebar-shortcut-ghost"
          style={{ left: shortcutGhost.x + 12, top: shortcutGhost.y + 10 }}
        >
          {shortcutGhost.label}
        </div>
      )}
    </aside>
  )
}
