import { afterEach, describe, expect, it, vi } from 'vitest'
import { TextSelection } from '@tiptap/pm/state'
import { DocumentCoordinator } from '../editor/DocumentCoordinator'
import { WorkspaceController } from './WorkspaceController'
import { commandAvailable, commandBinding, commandForKey, dispatchPaneCommand, openRightTarget, paneInputOwned } from './commands'

const disposals: Array<() => void> = []
afterEach(() => { disposals.splice(0).forEach(dispose => dispose()); vi.restoreAllMocks() })
function fixture() {
  const capture = vi.fn()
  const documentCoordinator = new DocumentCoordinator({ type: 'doc', content: [{ type: 'bulletList', content: [
    { type: 'listItem', attrs: { nodeId: 'source' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Source' }] }] },
    { type: 'listItem', attrs: { nodeId: 'target' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Target' }] }] },
  ] }] }, { onTransaction: capture })
  const workspace = new WorkspaceController(documentCoordinator)
  const element = document.body.appendChild(document.createElement('div'))
  const editor = documentCoordinator.createView('primary', { element })
  workspace.attach('primary', editor, element)
  disposals.push(() => { documentCoordinator.destroy(); element.remove() })
  return { editor, workspace, capture }
}
describe('shared pane commands', () => {
  it.each(['MacIntel', 'Linux'])('uses exact platform bindings on %s', platform => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform)
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('test')
    const modifier = platform === 'MacIntel' ? { metaKey: true } : { ctrlKey: true }
    expect(commandForKey(new KeyboardEvent('keydown', { ...modifier, code: 'Enter', key: 'Enter', shiftKey: true }))).toBe('openRight')
    expect(commandForKey(new KeyboardEvent('keydown', { ...modifier, code: 'Backslash', key: '|', shiftKey: true }))).toBe('split')
    expect(commandForKey(new KeyboardEvent('keydown', { ...modifier, code: 'ArrowLeft', altKey: true }))).toBe('previous')
    expect(commandForKey(new KeyboardEvent('keydown', { ...modifier, code: 'ArrowRight', altKey: true }))).toBe('next')
    expect(commandForKey(new KeyboardEvent('keydown', { ...modifier, code: 'KeyW' }))).toBe('close')
    expect(commandForKey(new KeyboardEvent('keydown', { ...modifier, code: 'KeyW', shiftKey: true }))).toBeNull()
    expect(commandBinding('split')).toBe(`${platform === 'MacIntel' ? '⌘' : 'Ctrl'}+Shift+\\`)
  })
  it('prefers the focused link, falls back to the current node, and protects the last outline', () => {
    const { editor, workspace, capture } = fixture()
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 3)))
    expect(openRightTarget(workspace, 'primary')).toEqual({ kind: 'outline', nodeId: 'source' })
    editor.view.dispatch(editor.state.tr.addMark(2, 8, editor.schema.marks.internalLink.create({ targetId: 'target' })))
    capture.mockClear()
    expect(openRightTarget(workspace, 'primary')).toEqual({ kind: 'outline', nodeId: 'target' })
    expect(dispatchPaneCommand(workspace, 'primary', 'openRight')).toBe(true)
    expect(workspace.getSnapshot().panes[1].current.location).toEqual({ kind: 'outline', nodeId: 'target' })
    expect(dispatchPaneCommand(workspace, workspace.getSnapshot().activePaneId, 'previous')).toBe(true)
    expect(workspace.getSnapshot().activePaneId).toBe('primary')
    expect(commandAvailable(workspace, 'primary', 'previous')).toBe(false)
    workspace.close(workspace.getSnapshot().panes[1].id)
    expect(dispatchPaneCommand(workspace, 'primary', 'close')).toBe(false)
    expect(capture).not.toHaveBeenCalled()
  })
  it('defers to forms, modals, menus and composition while allowing an outline caret', () => {
    const { editor } = fixture()
    editor.view.focus()
    expect(paneInputOwned()).toBe(false)
    const input = document.body.appendChild(document.createElement('input'))
    input.focus(); expect(paneInputOwned()).toBe(true)
    expect(paneInputOwned(undefined, true)).toBe(false) // Native focus can leave a stale HTML activeElement.
    input.remove(); editor.view.focus()
    const modal = document.body.appendChild(document.createElement('div'))
    modal.setAttribute('aria-modal', 'true'); expect(paneInputOwned()).toBe(true)
    modal.removeAttribute('aria-modal'); modal.setAttribute('role', 'menu'); expect(paneInputOwned()).toBe(true)
    modal.remove()
    expect(paneInputOwned(new KeyboardEvent('keydown', { isComposing: true }))).toBe(true)
  })
})
