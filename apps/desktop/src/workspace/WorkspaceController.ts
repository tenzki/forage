import type { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import { findBullet } from '../editor/outlineModel'
import { registerPaneNavigation, syncPaneNavigation } from '../editor/outlinerUi'
import type { DocumentCoordinator } from '../editor/DocumentCoordinator'
import { canClosePane, initialWorkspace, outlineTarget, workspaceReducer, type PaneLocation, type WorkspaceAction } from './workspaceState'

/** Session UI only: no document copies, persistence, or history authority. */
export class WorkspaceController {
  private state = initialWorkspace()
  private revealListeners = new Set<(id: string) => void>()
  onReveal = (listener: (id: string) => void) => { this.revealListeners.add(listener); return () => { this.revealListeners.delete(listener) } }
  private listeners = new Set<() => void>()
  private views = new Map<string, { editor: Editor; scroller: HTMLElement }>()
  constructor(readonly document: DocumentCoordinator, private onError: (message: string) => void = () => {}) {}
  getSnapshot = () => this.state
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  editor(id = outlineTarget(this.state).id): Editor | null { return this.views.get(id)?.editor ?? null }
  private dispatch(action: WorkspaceAction): void {
    const previous = this.state
    this.state = workspaceReducer(previous, action)
    if (this.state === previous) return
    if (previous.activePaneId !== this.state.activePaneId
      && this.state.panes.find(pane => pane.id === this.state.activePaneId)?.current.location.kind === 'web') {
      this.document.deactivate()
    }
    for (const pane of this.state.panes) {
      const view = this.views.get(pane.id)
      if (!view || pane.current.location.kind !== 'outline') continue
      const prior = previous.panes.find(item => item.id === pane.id)
      if (prior?.current.location !== pane.current.location || prior.back !== pane.back || prior.forward !== pane.forward) {
        this.projectNavigation(pane.id)
        view.scroller.scrollTop = pane.current.scrollTop
      }
    }
    this.listeners.forEach(listener => listener())
  }
  private saveScroll(id: string): void {
    const view = this.views.get(id)
    if (view) this.dispatch({ type: 'scroll', id, scrollTop: view.scroller.scrollTop })
  }
  private projectNavigation(id: string): void {
    const pane = this.state.panes.find(pane => pane.id === id)!
    const view = this.views.get(id)
    if (!view || pane.current.location.kind !== 'outline') return
    const nodeId = (location: PaneLocation) => location.kind === 'outline' ? location.nodeId : null
    syncPaneNavigation(view.editor, pane.current.location.nodeId, pane.back.map(visit => nodeId(visit.location)), pane.forward.map(visit => nodeId(visit.location)))
  }
  attach(id: string, editor: Editor, scroller: HTMLElement): () => void {
    this.views.set(id, { editor, scroller })
    const unregister = registerPaneNavigation(editor, {
      zoom: nodeId => { this.navigate(id, { kind: 'outline', nodeId }); this.activate(id, false) },
      back: () => this.history(id, 'back'), forward: () => this.history(id, 'forward'),
    })
    this.projectNavigation(id)
    scroller.scrollTop = this.state.panes.find(pane => pane.id === id)!.current.scrollTop
    if (this.state.activePaneId === id) this.activate(id)
    return () => { unregister(); if (this.views.get(id)?.editor === editor) this.views.delete(id) }
  }
  activate(id: string, focus = true): void {
    this.dispatch({ type: 'activate', id })
    this.revealListeners.forEach(listener => listener(id))
    const view = this.views.get(id)
    if (!view) return
    this.document.activate(id)
    if (!focus || view.editor.isDestroyed) return
    const pane = this.state.panes.find(pane => pane.id === id)!
    if (pane.current.location.kind === 'outline' && pane.current.location.nodeId) {
      const target = findBullet(view.editor.state.doc, pane.current.location.nodeId)
      if (!target) return
      const selection = view.editor.state.selection
      if (selection.from < target.pos || selection.to > target.pos + target.node.nodeSize) {
        view.editor.view.dispatch(view.editor.state.tr.setSelection(TextSelection.near(view.editor.state.doc.resolve(target.pos + 2))))
      }
    }
    view.editor.view.focus()
  }
  navigate(id: string, location: PaneLocation): boolean {
    const pane = this.state.panes.find(pane => pane.id === id)
    if (!pane || pane.current.location.kind !== location.kind) return false
    if (location.kind === 'outline' && location.nodeId && !findBullet(this.document.editor.state.doc, location.nodeId)) {
      this.onError('Linked item no longer exists.'); return false
    }
    this.saveScroll(id)
    this.dispatch({ type: 'navigate', id, location })
    return true
  }
  openRight(sourceId: string, location: PaneLocation): string | null {
    if (!this.state.panes.some(pane => pane.id === sourceId)) return null
    if (location.kind === 'outline' && location.nodeId && !findBullet(this.document.editor.state.doc, location.nodeId)) {
      this.onError('Linked item no longer exists.'); return null
    }
    const id = crypto.randomUUID()
    this.dispatch({ type: 'open', sourceId, id, location })
    return id
  }
  split(id: string): void { this.saveScroll(id); this.dispatch({ type: 'split', sourceId: id, id: crypto.randomUUID() }) }
  close(id: string): void {
    if (!canClosePane(this.state, id)) return
    const wasActive = this.state.activePaneId === id
    this.dispatch({ type: 'close', id })
    if (wasActive) this.activate(this.state.activePaneId)
  }
  history(id: string, direction: 'back' | 'forward'): boolean {
    const pane = this.state.panes.find(pane => pane.id === id)
    if (!pane?.[direction].length) return false
    this.saveScroll(id); this.dispatch({ type: direction, id }); this.activate(id)
    return true
  }
  resizePair(id: string, delta: number, minimum: number, leftWidth?: number, rightWidth?: number): void { this.dispatch({ type: 'resizePair', id, delta, minimum, leftWidth, rightWidth }) }
  resize(id: string, width: number): void { if (Number.isFinite(width)) this.dispatch({ type: 'width', id, width }) }
  scroll(id: string, scrollTop: number): void { this.dispatch({ type: 'scroll', id, scrollTop }) }
}
