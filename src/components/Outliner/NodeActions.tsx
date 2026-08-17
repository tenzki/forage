import { useEffect, useMemo, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import {
  collectBullets,
  duplicateBullet,
  moveBulletTo,
  trashBullet,
  type MovePlacement,
} from '../../editor/outlineModel'
import { toggleCollapsed } from '../../editor/outlinerUi'
import type { TrashEntry } from '../../types/tree'

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
  const [targetId, setTargetId] = useState('root')
  const [placement, setPlacement] = useState<MovePlacement>('inside')

  function submit(event: React.FormEvent) {
    event.preventDefault()
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
        <h2 id="move-title">Move bullet</h2>
        <label htmlFor="move-destination">Destination</label>
        <select id="move-destination" value={targetId} onChange={(event) => setTargetId(event.target.value)} autoFocus>
          <option value="root">Home (end of outline)</option>
          {destinations.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {`${'—'.repeat(entry.ancestorIds.length)} ${entry.text.trim() || 'Untitled'}`}
            </option>
          ))}
        </select>
        <label htmlFor="move-placement">Placement</label>
        <select id="move-placement" value={placement} disabled={targetId === 'root'} onChange={(event) => setPlacement(event.target.value as MovePlacement)}>
          <option value="inside">Inside destination</option>
          <option value="before">Before destination</option>
          <option value="after">After destination</option>
        </select>
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="primary-action" type="submit">Move</button>
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

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    menuRef.current?.querySelector('button')?.focus()
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [onClose])

  if (moving) {
    return <MoveToDialog editor={editor} sourceId={request.nodeId} onClose={onClose} onError={onError} />
  }
  if (!entry) return null

  function remove() {
    const deleted = trashBullet(editor, request.nodeId)
    if (deleted) onTrashed(deleted)
    else onError('The bullet could not be moved to Trash.')
    onClose()
  }

  return (
    <>
      <button className="node-menu-dismiss" aria-label="Close bullet actions" onClick={onClose} />
      <div ref={menuRef} className="node-action-menu" role="menu" aria-label={`Actions for ${entry.text || 'untitled bullet'}`} style={{ top: request.top, left: request.left }}>
        {children && (
          <button role="menuitem" onClick={() => { toggleCollapsed(editor, request.nodeId); onClose() }}>
            {entry.node.attrs.collapsed ? 'Expand branch' : 'Collapse branch'}
          </button>
        )}
        <button role="menuitem" onClick={() => setMoving(true)}>Move to…</button>
        <button role="menuitem" onClick={() => { onToggleShortcut(); onClose() }}>
          {isShortcut ? 'Remove from shortcuts' : 'Add to shortcuts'}
        </button>
        <button role="menuitem" onClick={() => { duplicateBullet(editor, request.nodeId); onClose() }}>Duplicate branch</button>
        <button role="menuitem" onClick={() => void copyNodeLink(request.nodeId).then(onClose).catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)))}>
          Copy bullet link
        </button>
        <button className="danger-action" role="menuitem" onClick={remove}>Move to Trash</button>
      </div>
    </>
  )
}
