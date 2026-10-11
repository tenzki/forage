import { useEffect, useRef, useState } from 'react'
import { Ellipsis, X } from 'lucide-react'
import { IconButton } from '../components/ui/IconButton'
import type { WorkspaceController } from './WorkspaceController'
import { commandAvailable, commandBinding, dispatchPaneCommand, paneCommands } from './commands'

export function PaneActions({ workspace, id, children }: { workspace: WorkspaceController; id: string; children?: React.ReactNode }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open])
  return <div className="pane-actions" ref={root} data-preserve-pane-focus>
    <IconButton label="Pane actions" title="Pane actions" aria-expanded={open} onClick={() => setOpen(value => !value)}><Ellipsis size={16} /></IconButton>
    {open && <div className="pane-menu" data-pane-menu="open" role="menu" aria-label="Pane actions" onKeyDown={event => {
      if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); root.current?.querySelector('button')?.focus() }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
        const index = items.indexOf(document.activeElement as HTMLButtonElement)
        items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
      }
    }}>
      {paneCommands.map(command => <button role="menuitem" key={command.id} disabled={!commandAvailable(workspace, id, command.id)}
        onClick={() => { setOpen(false); dispatchPaneCommand(workspace, id, command.id) }}>{command.label}<small>{commandBinding(command.id)}</small></button>)}
      {children}
    </div>}
    {commandAvailable(workspace, id, 'close') && <IconButton label="Close pane" title={`Close pane (${commandBinding('close')})`}
      onMouseDown={event => event.preventDefault()} onClick={() => dispatchPaneCommand(workspace, id, 'close')}><X size={16} /></IconButton>}
  </div>
}
