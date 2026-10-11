import { useCallback, useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/core'
import { OutlinerEditor } from '../editor/OutlinerEditor'
import { OutlinerChrome } from '../components/Outliner/OutlinerChrome'
import { BacklinksPanel } from '../components/Outliner/BacklinksPanel'
import { findBullet } from '../editor/outlineModel'
import { PaneActions } from './PaneActions'
import { canClosePane, type WorkspacePane } from './workspaceState'
import type { WorkspaceController } from './WorkspaceController'
import type { OutlineShortcut, TrashEntry } from '../types/tree'

interface Props {
  workspace: WorkspaceController
  pane: WorkspacePane
  active: boolean
  globalTarget: boolean
  onReady: () => void
  onUndo: (editor: Editor) => boolean
  onRedo: (editor: Editor) => boolean
  trash: TrashEntry[]
  onTrashChange: (entries: TrashEntry[]) => void
  shortcuts: OutlineShortcut[]
  onShortcutsChange: (shortcuts: OutlineShortcut[]) => void
  sidebarCollapsed: boolean
  onToggleSidebar: () => void
  activitySidebarCollapsed: boolean
  onToggleActivitySidebar: () => void
  onOpenSettings: () => void
  onOpenTrash: () => void
  onOpenInbox: () => void
  onOpenDailyNotes: () => void
  onOpenTasks: () => void
}
export function OutlinePane({ workspace, pane, active, globalTarget, onReady, ...chrome }: Props) {
  const scroller = useRef<HTMLDivElement>(null)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [, setRevision] = useState(0)
  const ready = useCallback((editor: Editor) => { setEditor(editor) }, [])
  useEffect(() => {
    if (!editor || editor.isDestroyed || !scroller.current) return
    const detach = workspace.attach(pane.id, editor, scroller.current)
    onReady()
    const update = () => setRevision(value => value + 1)
    editor.on('transaction', update)
    return () => { editor.off('transaction', update); detach() }
  }, [workspace, pane.id, editor, onReady])
  const target = pane.current.location.kind === 'outline' ? pane.current.location.nodeId : null
  const missing = Boolean(target && editor && !findBullet(editor.state.doc, target))
  return <section className="workspace-outline-pane" data-pane-id={pane.id} style={{ flexBasis: pane.width }}
    aria-label={target ? `Outline pane ${editor && findBullet(editor.state.doc, target)?.text || 'Unavailable'}` : 'Home outline pane'}
    onPointerDownCapture={event => { if (!(event.target as Element).closest('[data-preserve-pane-focus]')) workspace.activate(pane.id, false) }}
    onFocusCapture={event => { if (!(event.target as Element).closest('[data-preserve-pane-focus]')) workspace.activate(pane.id, false) }}>
    <OutlinerChrome editor={editor} active={active} globalTarget={globalTarget} paneActions={<PaneActions workspace={workspace} id={pane.id} />} {...chrome} />
    <div className="workspace-pane-scroll" ref={scroller} onScroll={event => workspace.scroll(pane.id, event.currentTarget.scrollTop)}>
      {missing && <div className="pane-unavailable" role="status">
        <p>This item is unavailable.</p>
        <button disabled={!pane.back.length} onClick={() => workspace.history(pane.id, 'back')}>Back</button>
        <button onClick={() => { workspace.navigate(pane.id, { kind: 'outline', nodeId: null }); workspace.activate(pane.id) }}>Home</button>
        <button data-preserve-pane-focus onMouseDown={event => event.preventDefault()} disabled={!canClosePane(workspace.getSnapshot(), pane.id)} onClick={() => workspace.close(pane.id)}>Close</button>
      </div>}
      <div hidden={missing}>
        <OutlinerEditor coordinator={workspace.document} paneId={pane.id} onReady={ready} onUndo={chrome.onUndo} onRedo={chrome.onRedo} />
        {editor && <BacklinksPanel editor={editor} />}
      </div>
    </div>
  </section>
}
