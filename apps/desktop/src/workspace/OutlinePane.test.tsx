import { act, render, waitFor } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { expect, it, vi } from 'vitest'
import { DocumentCoordinator } from '../editor/DocumentCoordinator'
import { WorkspaceController } from './WorkspaceController'
import { OutlinePane } from './OutlinePane'
import { outlineTarget } from './workspaceState'
import type { Editor } from '@tiptap/core'
import { getOutlinerUiState } from '../editor/outlinerUi'

const ready = () => {}
function Harness({ workspace }: { workspace: WorkspaceController }) {
  const state = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot)
  return <>{state.panes.map(pane => <OutlinePane key={pane.id} workspace={workspace} pane={pane}
    active={state.activePaneId === pane.id} globalTarget={outlineTarget(state).id === pane.id}
    onReady={ready} onUndo={() => false} onRedo={() => false}
    trash={[]} onTrashChange={ready} shortcuts={[]} onShortcutsChange={ready}
    sidebarCollapsed={false} onToggleSidebar={ready} activitySidebarCollapsed={false} onToggleActivitySidebar={ready}
    onOpenSettings={ready} onOpenTrash={ready} onOpenInbox={ready} onOpenDailyNotes={ready} onOpenTasks={ready} />)}</>
}
it('resets mounted views to Home when a new loaded outline replaces the workspace', async () => {
  const doc = (id: string, text: string) => ({ type: 'doc', content: [{ type: 'bulletList', content: [{
    type: 'listItem', attrs: { nodeId: id }, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  }] }] })
  const capture = vi.fn()
  const firstDoc = new DocumentCoordinator(doc('old-node', 'Old outline'), { onTransaction: capture })
  const secondDoc = new DocumentCoordinator(doc('new-node', 'New outline'), { onTransaction: capture })
  const first = new WorkspaceController(firstDoc)
  const second = new WorkspaceController(secondDoc)
  const rendered = render(<Harness workspace={first} />)
  try {
    await waitFor(() => expect(first.editor()).not.toBeNull())
    act(() => { first.navigate('primary', { kind: 'outline', nodeId: 'old-node' }); first.split('primary') })
    await waitFor(() => expect(rendered.container.querySelectorAll('.ProseMirror')).toHaveLength(2))
    const oldViews = Array.from(rendered.container.querySelectorAll<HTMLElement & { editor: Editor }>('.ProseMirror')).map(dom => dom.editor)
    rendered.rerender(<Harness workspace={second} />)
    await waitFor(() => expect(second.editor()).not.toBeNull())
    expect(rendered.container.querySelectorAll('.ProseMirror')).toHaveLength(1)
    expect(oldViews.every(editor => editor.isDestroyed)).toBe(true)
    expect(getOutlinerUiState(second.editor()!)).toMatchObject({ zoomId: null, backStack: [], forwardStack: [] })
    expect(second.getSnapshot().panes[0].current.scrollTop).toBe(0)
    expect(second.editor()!.state.doc.textContent).toContain('New outline')
    expect(second.editor()!.state.doc.textContent).not.toContain('Old outline')
    expect(capture).not.toHaveBeenCalled()
  } finally {
    rendered.unmount()
    firstDoc.destroy()
    secondDoc.destroy()
  }
})
