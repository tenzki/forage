import { useEffect, useMemo, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  FileText,
  FolderInput,
  Home,
  Link,
  List,
  NotebookPen,
  Pin,
  PinOff,
  Trash2,
  XCircle,
} from 'lucide-react'
import {
  collectBullets,
  duplicateBullet,
  moveBulletTo,
  normalizeSearchText,
  setBulletKind,
  toggleBulletCompleted,
  trashBullet,
  type MovePlacement,
} from '../../editor/outlineModel'
import {
  focusOrCreateBulletNote,
  hasBulletNote,
  removeBulletNote,
} from '../../editor/bulletNote'
import { toggleCollapsed } from '../../editor/outlinerUi'
import type { TrashEntry } from '../../types/tree'
import { validateSystemNodeAction, type StructuralAction } from '../../editor/systemNodeGuards'
import { DropdownMenu, DropdownMenuItem, DropdownMenuSeparator } from '../ui/DropdownMenu'
import { SearchInput } from '../ui/SearchInput'
import { SegmentedControl } from '../ui/SegmentedControl'

interface MenuPosition {
  nodeId: string
  top: number
  left: number
  moveImmediately?: boolean
}

interface NodeActionsProps {
  editor: Editor
  request: MenuPosition
  onClose: () => void
  onTrashed: (entry: TrashEntry) => void
  onError: (message: string) => void
  isShortcut: boolean
  onToggleShortcut: () => void
}

interface MoveDestinationOption {
  id: string
  label: string
  path: string
  order: number
}

const MOVE_RECENTS_KEY = 'forage.move-recent-destinations'
const MOVE_RECENTS_LIMIT = 8
const IS_APPLE_PLATFORM = typeof navigator !== 'undefined'
  && /Mac|iPhone|iPad|iPod/u.test(`${navigator.platform} ${navigator.userAgent}`)

function readRecentMoveDestinations(): string[] {
  try {
    const value = JSON.parse(window.localStorage.getItem(MOVE_RECENTS_KEY) ?? '[]')
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

function rememberMoveDestination(targetId: string, recentIds: string[]): string[] {
  const next = [targetId, ...recentIds.filter((id) => id !== targetId)].slice(0, MOVE_RECENTS_LIMIT)
  try {
    window.localStorage.setItem(MOVE_RECENTS_KEY, JSON.stringify(next))
  } catch {
    // Moving must keep working when local storage is unavailable.
  }
  return next
}

function moveDestinationScore(option: MoveDestinationOption, query: string, recentIndex: number): number | null {
  const label = normalizeSearchText(option.label)
  const path = normalizeSearchText(option.path)
  const searchable = `${label} ${path}`
  const terms = query.split(/\s+/u).filter(Boolean)
  if (!terms.every((term) => searchable.includes(term))) return null

  let score = 0
  if (!query) score = option.id === 'root' ? 500 : 0
  else if (label === query) score = 1_000
  else if (label.startsWith(query)) score = 800
  else if (label.split(/\s+/u).some((word) => word.startsWith(query))) score = 700
  else if (label.includes(query)) score = 500
  else if (path.includes(query)) score = 250

  if (recentIndex >= 0) score += query ? 120 - recentIndex * 10 : 2_000 - recentIndex
  return score
}

function hasChildren(editor: Editor, nodeId: string): boolean {
  const entry = collectBullets(editor.state.doc).find((item) => item.id === nodeId)
  if (!entry) return false
  for (let index = 0; index < entry.node.childCount; index += 1) {
    if (entry.node.child(index).type.name === 'bulletList') return true
  }
  return false
}

async function copyNodeLink(nodeId: string): Promise<void> {
  const url = new URL(window.location.href)
  url.hash = `node=${encodeURIComponent(nodeId)}`
  if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable.')
  await navigator.clipboard.writeText(url.toString())
}

function MoveToDialog({
  editor,
  sourceId,
  onClose,
  onError,
}: {
  editor: Editor
  sourceId: string
  onClose: () => void
  onError: (message: string) => void
}) {
  const destinations = useMemo(() => {
    const entries = collectBullets(editor.state.doc)
    const source = entries.find((entry) => entry.id === sourceId)
    const excluded = new Set([sourceId, ...(entries
      .filter((entry) => entry.ancestorIds.includes(sourceId))
      .map((entry) => entry.id))])
    return entries.filter((entry) => !excluded.has(entry.id) && entry.id !== source?.id)
  }, [editor, sourceId])
  const [query, setQuery] = useState('')
  const [targetId, setTargetId] = useState<string | null>(null)
  const [placement, setPlacement] = useState<MovePlacement>('inside')
  const [activeIndex, setActiveIndex] = useState(0)
  const [recentIds, setRecentIds] = useState(readRecentMoveDestinations)

  const destinationOptions = useMemo(() => {
    const byId = new Map(destinations.map((entry) => [entry.id, entry]))
    return [
      { id: 'root', label: 'Home', path: 'Top level', order: 0 },
      ...destinations.map((entry, index) => ({
        id: entry.id,
        label: entry.text.trim() || 'Untitled',
        path: entry.ancestorIds
          .map((ancestorId) => byId.get(ancestorId)?.text.trim())
          .filter(Boolean)
          .join(' › ') || 'Home',
        order: index + 1,
      })),
    ]
  }, [destinations])

  const filteredOptions = useMemo(() => {
    const normalizedQuery = normalizeSearchText(query.trim())
    return destinationOptions
      .map((option) => ({
        option,
        score: moveDestinationScore(option, normalizedQuery, recentIds.indexOf(option.id)),
      }))
      .filter((candidate): candidate is { option: MoveDestinationOption; score: number } => candidate.score !== null)
      .sort((left, right) => right.score - left.score || left.option.order - right.option.order)
      .slice(0, 50)
      .map(({ option }) => option)
  }, [destinationOptions, query, recentIds])

  const selectedOption = destinationOptions.find((option) => option.id === targetId)
  const activeOption = filteredOptions[activeIndex] ?? filteredOptions[0]
  const shortcutTargetId = targetId ?? (query.trim() ? activeOption?.id ?? null : null)

  useEffect(() => {
    setActiveIndex(0)
  }, [query])

  function selectActiveDestination() {
    const option = filteredOptions[activeIndex]
    if (option) setTargetId(option.id)
  }

  function handleSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((current) => filteredOptions.length ? (current + 1) % filteredOptions.length : 0)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((current) => filteredOptions.length ? (current - 1 + filteredOptions.length) % filteredOptions.length : 0)
    } else if (event.key === 'Enter' && !(event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      selectActiveDestination()
    }
  }

  function move(destinationId: string | null = targetId) {
    if (!destinationId) return
    const target = destinationId === 'root' ? null : destinationId
    if (!moveBulletTo(editor, sourceId, target, target ? placement : 'inside')) {
      onError('That branch cannot be moved to the selected destination.')
      return
    }
    setRecentIds(rememberMoveDestination(destinationId, recentIds))
    onClose()
  }

  function submit(event: React.FormEvent) {
    event.preventDefault()
    move(shortcutTargetId)
  }

  useEffect(() => {
    const moveWithShortcut = (event: KeyboardEvent) => {
      const isReturn = event.key === 'Enter' || event.code === 'Enter' || event.code === 'NumpadEnter'
      if (!(event.metaKey || event.ctrlKey) || !isReturn) return
      event.preventDefault()
      event.stopPropagation()
      move(shortcutTargetId)
    }
    window.addEventListener('keydown', moveWithShortcut, { capture: true })
    return () => window.removeEventListener('keydown', moveWithShortcut, { capture: true })
  }, [shortcutTargetId, placement, recentIds])

  return (
    <div className="search-backdrop" onMouseDown={onClose}>
      <form className="move-dialog" role="dialog" aria-modal="true" aria-labelledby="move-title" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}>
        <header className="move-dialog-header">
          <h2 id="move-title">Move bullet</h2>
          <p>Search for where this branch should go.</p>
        </header>
        <div className="move-dialog-search">
          <SearchInput
            autoFocus
            aria-label="Search move destinations"
            placeholder="Search bullets…"
            value={query}
            onValueChange={setQuery}
            onClear={() => setQuery('')}
            onKeyDown={handleSearchKeyDown}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls="move-destination-results"
            aria-activedescendant={filteredOptions.length ? `move-destination-${activeIndex}` : undefined}
          />
        </div>
        <ul id="move-destination-results" className="move-destination-results" role="listbox" aria-label="Move destinations">
          {filteredOptions.map((option, index) => {
            const selected = option.id === targetId
            const active = index === activeIndex
            const recent = recentIds.includes(option.id)
            return (
              <li
                id={`move-destination-${index}`}
                key={option.id}
                role="option"
                aria-selected={selected}
                className={active ? 'is-active' : undefined}
              >
                <button
                  type="button"
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => setTargetId(option.id)}
                >
                  <span className="move-destination-icon" aria-hidden="true">
                    {option.id === 'root' ? <Home size={15} /> : <FolderInput size={15} />}
                  </span>
                  <span className="move-destination-copy">
                    <span className="move-destination-title"><strong>{option.label}</strong>{recent ? <small>Recent</small> : null}</span>
                    <small>{option.path}</small>
                  </span>
                  {selected ? <Check className="move-destination-check" size={16} aria-hidden="true" /> : null}
                </button>
              </li>
            )
          })}
          {!filteredOptions.length ? <li className="move-destination-empty">No destinations match “{query}”.</li> : null}
        </ul>
        <div className="move-placement">
          <div>
            <strong>{selectedOption ? `Move to ${selectedOption.label}` : 'Choose a destination'}</strong>
            <small>{targetId === 'root' ? 'The branch will be appended to the top level.' : selectedOption?.path ?? 'Search above, then select a result.'}</small>
          </div>
          {targetId && targetId !== 'root' ? (
            <SegmentedControl
              ariaLabel="Move placement"
              value={placement}
              options={[
                { value: 'inside', label: 'Inside' },
                { value: 'before', label: 'Before' },
                { value: 'after', label: 'After' },
              ]}
              onValueChange={setPlacement}
            />
          ) : null}
        </div>
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="move-submit" type="submit" disabled={!shortcutTargetId} aria-keyshortcuts="Meta+Enter Control+Enter">
            <span>Move here</span>
            <kbd aria-hidden="true">{IS_APPLE_PLATFORM ? '⌘' : 'Ctrl'} ↵</kbd>
          </button>
        </div>
      </form>
    </div>
  )
}

export function NodeActions({
  editor,
  request,
  onClose,
  onTrashed,
  onError,
  isShortcut,
  onToggleShortcut,
}: NodeActionsProps) {
  const [moving, setMoving] = useState(request.moveImmediately === true)
  const menuRef = useRef<HTMLDivElement>(null)
  const entry = collectBullets(editor.state.doc).find((item) => item.id === request.nodeId)
  const children = hasChildren(editor, request.nodeId)
  const hasNote = hasBulletNote(editor, request.nodeId)

  useEffect(() => {
    const handleKeyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
        return
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])
      if (!items.length) return
      event.preventDefault()
      const currentIndex = items.findIndex((item) => item === document.activeElement)
      const nextIndex = event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : event.key === 'ArrowDown'
            ? (currentIndex + 1) % items.length
            : (currentIndex - 1 + items.length) % items.length
      items[nextIndex]?.focus()
    }
    menuRef.current?.querySelector('button')?.focus()
    window.addEventListener('keydown', handleKeyboard)
    return () => window.removeEventListener('keydown', handleKeyboard)
  }, [onClose])

  if (moving) {
    return <MoveToDialog editor={editor} sourceId={request.nodeId} onClose={onClose} onError={onError} />
  }
  if (!entry) return null
  const isProtectedEntry = entry.systemRole !== null

  function allowed(action: StructuralAction, reportError = true): boolean {
    const decision = validateSystemNodeAction(editor.state.doc, action, request.nodeId)
    if (!decision.allowed && reportError) onError(decision.message)
    return decision.allowed
  }

  function remove() {
    if (!allowed('trash', !isProtectedEntry)) {
      onClose()
      return
    }
    const deleted = trashBullet(editor, request.nodeId)
    if (deleted) onTrashed(deleted)
    else onError('The bullet could not be moved to Trash.')
    onClose()
  }

  return (
    <>
      <button className="node-menu-dismiss" aria-label="Close bullet actions" onClick={onClose} />
      <DropdownMenu ref={menuRef} role="menu" aria-label={`Actions for ${entry.text || 'untitled bullet'}`} style={{ top: request.top, left: request.left }}>
        {children && (
          <DropdownMenuItem icon={entry.node.attrs.collapsed ? ChevronRight : ChevronDown} onClick={() => { toggleCollapsed(editor, request.nodeId); onClose() }}>
            {entry.node.attrs.collapsed ? 'Expand branch' : 'Collapse branch'}
          </DropdownMenuItem>
        )}
        {entry.bulletKind === 'todo' ? (
          <>
            <DropdownMenuItem icon={entry.completed ? XCircle : CheckCircle2} onClick={() => { if (allowed('convert')) toggleBulletCompleted(editor, request.nodeId); onClose() }}>
              {entry.completed ? 'Mark as open' : 'Mark as complete'}
            </DropdownMenuItem>
            <DropdownMenuItem icon={List} onClick={() => { if (allowed('convert')) setBulletKind(editor, request.nodeId, 'bullet'); onClose() }}>
              Convert to bullet
            </DropdownMenuItem>
          </>
        ) : (
          <DropdownMenuItem icon={CheckCircle2} onClick={() => { if (allowed('convert')) setBulletKind(editor, request.nodeId, 'todo'); onClose() }}>
            Convert to todo
          </DropdownMenuItem>
        )}
        <DropdownMenuItem icon={NotebookPen} onClick={() => { focusOrCreateBulletNote(editor, request.nodeId); onClose() }}>
          {hasNote ? 'Edit note' : 'Add note'}
        </DropdownMenuItem>
        {hasNote && (
          <DropdownMenuItem icon={FileText} onClick={() => { removeBulletNote(editor, request.nodeId); onClose() }}>
            Remove note
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem icon={FolderInput} shortcut={IS_APPLE_PLATFORM ? '⌘M' : 'Ctrl M'} aria-keyshortcuts="Meta+M Control+M" onClick={() => { if (allowed('move')) setMoving(true); else onClose() }}>Move to…</DropdownMenuItem>
        <DropdownMenuItem icon={isShortcut ? PinOff : Pin} onClick={() => { onToggleShortcut(); onClose() }}>
          {isShortcut ? 'Remove from shortcuts' : 'Add to shortcuts'}
        </DropdownMenuItem>
        <DropdownMenuItem icon={Copy} shortcut="⌘D" onClick={() => { if (allowed('duplicate')) duplicateBullet(editor, request.nodeId); onClose() }}>Duplicate branch</DropdownMenuItem>
        <DropdownMenuItem icon={Link} onClick={() => void copyNodeLink(request.nodeId).then(onClose).catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)))}>
          Copy bullet link
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem icon={Trash2} danger onClick={remove}>Move to Trash</DropdownMenuItem>
      </DropdownMenu>
    </>
  )
}
