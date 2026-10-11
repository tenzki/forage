import definitions from './paneCommands.json'
import { currentBulletId, findBullet } from '../editor/outlineModel'
import { canClosePane, type PaneLocation } from './workspaceState'
import type { WorkspaceController } from './WorkspaceController'

export const applePlatform = () => /Mac|iPhone|iPad|iPod/u.test(`${navigator.platform} ${navigator.userAgent}`)
export type PaneCommand = 'openRight' | 'split' | 'previous' | 'next' | 'close'
export const paneCommands = definitions as Array<{ id: PaneCommand; label: string; key: string; code: string; nativeKeyCode: number; shift: boolean; alt: boolean }>
export function commandBinding(id: PaneCommand): string {
  const command = paneCommands.find(item => item.id === id)!
  return [applePlatform() ? '⌘' : 'Ctrl', command.shift ? 'Shift' : '', command.alt ? applePlatform() ? 'Option' : 'Alt' : '', command.key].filter(Boolean).join('+')
}
export function commandForKey(event: KeyboardEvent): PaneCommand | null {
  if (applePlatform() ? !event.metaKey || event.ctrlKey : !event.ctrlKey || event.metaKey) return null
  return paneCommands.find(command => (event.code === command.code || event.key.toLowerCase() === command.key.toLowerCase())
    && event.shiftKey === command.shift && event.altKey === command.alt)?.id ?? null
}
export function paneInputOwned(event?: KeyboardEvent, nativePage = false): boolean {
  if (event?.isComposing || event?.defaultPrevented || document.documentElement.dataset.paneComposing === 'true') return true
  const target = nativePage ? null : event?.target instanceof Element ? event.target : document.activeElement
  return Boolean(target?.closest('input, textarea, select, form, [role="menu"], [data-pane-menu], [contenteditable="true"]:not(.ProseMirror)')
    || document.querySelector('[aria-modal="true"], [role="menu"], [data-pane-menu="open"], .slash-menu, .internal-link-menu, .tag-menu'))
}
export function openRightTarget(workspace: WorkspaceController, id: string): PaneLocation | null {
  const editor = workspace.editor(id)
  if (!editor || editor.isDestroyed) return null
  const marks = [...editor.state.selection.$from.marks(), ...(editor.state.selection.$from.nodeAfter?.marks ?? [])]
  const internal = marks.find(mark => mark.type.name === 'internalLink')
  if (internal) return findBullet(editor.state.doc, internal.attrs.targetId) ? { kind: 'outline', nodeId: internal.attrs.targetId } : null
  const external = marks.find(mark => mark.type.name === 'link')
  const nodeId = currentBulletId(editor)
  if (external && /^https?:\/\//iu.test(external.attrs.href)) return { kind: 'web', href: external.attrs.href, sourceNodeId: nodeId ?? undefined }
  return nodeId ? { kind: 'outline', nodeId } : null
}
export function commandAvailable(workspace: WorkspaceController, id: string, command: PaneCommand): boolean {
  const state = workspace.getSnapshot()
  const index = state.panes.findIndex(pane => pane.id === id)
  if (index < 0) return false
  if (command === 'openRight') return Boolean(openRightTarget(workspace, id))
  if (command === 'close') return canClosePane(state, id)
  if (command === 'previous') return index > 0
  if (command === 'next') return index < state.panes.length - 1
  return true
}
export function dispatchPaneCommand(workspace: WorkspaceController, id: string, command: PaneCommand): boolean {
  if (!commandAvailable(workspace, id, command)) return false
  if (command === 'openRight') workspace.openRight(id, openRightTarget(workspace, id)!)
  else if (command === 'split') workspace.split(id)
  else if (command === 'close') workspace.close(id)
  else {
    const state = workspace.getSnapshot()
    const index = state.panes.findIndex(pane => pane.id === id)
    workspace.activate(state.panes[index + (command === 'previous' ? -1 : 1)].id)
  }
  return true
}
