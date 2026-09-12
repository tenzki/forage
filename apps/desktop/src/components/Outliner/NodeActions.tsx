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

  const destinationOptions = useMemo(() => {
    const byId = new Map(destinations.map((entry) => [entry.id, entry]))
    return [
      { id: 'root', label: 'Home', path: 'Top level' },
      ...destinations.map((entry) => ({
        id: entry.id,
        label: entry.text.trim() || 'Untitled',
        path: entry.ancestorIds
          .map((ancestorId) => byId.get(ancestorId)?.text.trim())
          .filter(Boolean)
          .join(' › ') || 'Home',
      })),
    ]
  }, [destinations])

  const filteredOptions = useMemo(() => {
    const normalizedQuery = normalizeSearchText(query.trim())
    const matching = normalizedQuery
      ? destinationOptions.filter((option) => normalizeSearchText(`${option.label} ${option.path}`).includes(normalizedQuery))
      : destinationOptions
    return matching.slice(0, 50)
  }, [destinationOptions, query])

  const selectedOption = destinationOptions.find((option) => option.id === targetId)

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
    } else if (event.key === 'Enter') {
      event.preventDefault()
      selectActiveDestination()
    }
  }

  function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!targetId) return
    const target = targetId === 'root' ? null : targetId
    if (!moveBulletTo(editor, sourceId, target, target ? placement : 'inside')) {
      onError('That branch cannot be moved to the selected destination.')
      return
    }
    onClose()
  }

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
                    <strong>{option.label}</strong>
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
          <button className="primary-action" type="submit" disabled={!targetId}>Move here</button>
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
  const [moving, setMoving] = useState(false)
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
        <DropdownMenuItem icon={FolderInput} onClick={() => { if (allowed('move')) setMoving(true); else onClose() }}>Move to…</DropdownMenuItem>
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
