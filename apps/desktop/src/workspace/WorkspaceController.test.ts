import { afterEach, describe, expect, it, vi } from 'vitest'
import { DocumentCoordinator } from '../editor/DocumentCoordinator'
import { getOutlinerUiState, setZoom, navigateBack, navigateForward } from '../editor/outlinerUi'
import { findBullet, trashBullet, restoreBullet, moveBulletTo } from '../editor/outlineModel'
import { WorkspaceController } from './WorkspaceController'
import { OUTLINE_INTERNAL_LINK_EVENT, type InternalLinkRequest } from '../editor/internalLinks'
import { OUTLINE_LINK_PEEK_EVENT, type LinkPeekRequest } from '../editor/externalLinks'
import { openUrl } from '@tauri-apps/plugin-opener'
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn(async () => {}) }))

const disposals: Array<() => void> = []
afterEach(() => { disposals.splice(0).reverse().forEach(dispose => dispose()); vi.restoreAllMocks() })
function fixture() {
  const capture = vi.fn()
  const errors = vi.fn()
  const switched = vi.fn()
  const item = (id: string, text: string) => ({ type: 'listItem', attrs: { nodeId: id }, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] })
  const documentCoordinator = new DocumentCoordinator({ type: 'doc', content: [{ type: 'bulletList', content: [item('alpha', 'Alpha'), item('beta', 'Beta')] }] }, { onTransaction: capture, onPaneSwitch: switched })
  const workspace = new WorkspaceController(documentCoordinator, errors)
  disposals.push(() => documentCoordinator.destroy())
  const attach = (id: string) => {
    const scroller = document.body.appendChild(document.createElement('div'))
    const editor = documentCoordinator.createView(id, { element: scroller.appendChild(document.createElement('div')) })
    const detach = workspace.attach(id, editor, scroller)
    disposals.push(() => { detach(); scroller.remove() })
    return { editor, scroller }
  }
  const a = attach('primary')
  return { workspace, documentCoordinator, capture, errors, switched, attach, a }
}
describe('workspace navigation over canonical views', () => {
  it('breaks typing groups when visiting a web pane and returning to the same outline', () => {
    const { workspace, switched } = fixture()
    switched.mockClear()
    workspace.openRight('primary', { kind: 'web', href: 'https://example.test', sourceNodeId: 'alpha' })
    expect(switched).toHaveBeenCalledOnce()
    workspace.activate('primary')
    expect(switched).toHaveBeenCalledTimes(2)
  })
  it('opens/splits without document events or node duplication and retains separate histories', () => {
    const { workspace, documentCoordinator, a, attach, capture } = fixture()
    const initial = documentCoordinator.editor.getJSON()
    a.scroller.scrollTop = 215
    setZoom(a.editor, 'alpha')
    a.scroller.scrollTop = 80
    workspace.split('primary')
    const id = workspace.getSnapshot().activePaneId
    const b = attach(id)
    expect(getOutlinerUiState(b.editor)).toMatchObject({ zoomId: 'alpha', backStack: [], forwardStack: [] })
    expect(b.scroller.scrollTop).toBe(80)
    setZoom(b.editor, 'beta')
    expect(getOutlinerUiState(a.editor).zoomId).toBe('alpha')
    expect(navigateBack(a.editor)).toBe(true)
    expect(a.scroller.scrollTop).toBe(215)
    expect(navigateForward(a.editor)).toBe(true)
    expect(a.scroller.scrollTop).toBe(80)
    expect(documentCoordinator.editor.getJSON()).toEqual(initial)
    expect(capture).not.toHaveBeenCalled()
  })
  it('rejects missing explicit targets but retains deleted locations/history through restoration', () => {
    const { workspace, documentCoordinator, a, capture, errors } = fixture()
    expect(workspace.openRight('primary', { kind: 'outline', nodeId: 'missing' })).toBeNull()
    expect(errors).toHaveBeenCalledOnce()
    expect(workspace.getSnapshot().panes).toHaveLength(1)
    setZoom(a.editor, 'alpha')
    const entry = trashBullet(documentCoordinator.editor, 'alpha')!
    expect(getOutlinerUiState(a.editor).zoomId).toBe('alpha')
    expect(workspace.getSnapshot().panes[0].current.location).toEqual({ kind: 'outline', nodeId: 'alpha' })
    restoreBullet(documentCoordinator.editor, entry)
    expect(findBullet(a.editor.state.doc, 'alpha')).not.toBeNull()
    expect(capture).toHaveBeenCalledTimes(2)
    navigateBack(a.editor)
    navigateForward(a.editor)
    expect(getOutlinerUiState(a.editor).zoomId).toBe('alpha')
  })
  it('keeps stable targets across rename/reparent and resolves navigation using the current document', () => {
    const { workspace, documentCoordinator, a } = fixture()
    setZoom(a.editor, 'alpha')
    const owner = documentCoordinator.editor
    const target = findBullet(owner.state.doc, 'alpha')!
    owner.view.dispatch(owner.state.tr.insertText('Renamed ', target.pos + 2))
    moveBulletTo(owner, 'alpha', 'beta', 'inside')
    const current = findBullet(a.editor.state.doc, 'alpha')!
    expect(current.text).toBe('Renamed Alpha')
    expect(current.ancestorIds).toContain('beta')
    expect(workspace.getSnapshot().panes[0].current.location).toEqual({ kind: 'outline', nodeId: 'alpha' })
  })
  it('closing inactive panes preserves native focus and active closure focuses the left survivor', () => {
    const { workspace, attach, a, documentCoordinator } = fixture()
    const bId = workspace.openRight('primary', { kind: 'outline', nodeId: 'alpha' })!
    const b = attach(bId)
    const cId = workspace.openRight(bId, { kind: 'outline', nodeId: 'beta' })!
    const c = attach(cId)
    workspace.activate('primary')
    workspace.close(cId)
    expect(document.activeElement).toBe(a.editor.view.dom)
    c.editor.destroy()
    workspace.activate(bId)
    workspace.close(bId)
    b.editor.destroy()
    expect(document.activeElement).toBe(a.editor.view.dom)
    expect(documentCoordinator.editor.isDestroyed).toBe(false)
  })

  it('addresses internal gestures to their source and uses platform-specific open-right modifiers', () => {
    const { a } = fixture()
    const events: InternalLinkRequest[] = []
    const listener = (event: Event) => events.push((event as CustomEvent<InternalLinkRequest>).detail)
    window.addEventListener(OUTLINE_INTERNAL_LINK_EVENT, listener)
    disposals.push(() => window.removeEventListener(OUTLINE_INTERNAL_LINK_EVENT, listener))
    const pos = findBullet(a.editor.state.doc, 'alpha')!.pos + 2
    a.editor.view.dispatch(a.editor.state.tr.insert(pos, a.editor.schema.text('Reference ', [a.editor.schema.marks.internalLink.create({ targetId: 'beta' })])))
    const link = a.editor.view.dom.querySelector('a[data-internal-node-id="beta"]')!
    const platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }))
    platform.mockReturnValue('Linux x86_64')
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true }))
    expect(events).toEqual([
      { sourcePaneId: 'primary', targetId: 'beta', openRight: false },
      { sourcePaneId: 'primary', targetId: 'beta', openRight: true },
      { sourcePaneId: 'primary', targetId: 'beta', openRight: true },
    ])
  })

  it('addresses external links to their source node/pane and preserves external-browser gestures', () => {
    const { a } = fixture()
    const requests: LinkPeekRequest[] = []
    const listener = (event: Event) => requests.push((event as CustomEvent<LinkPeekRequest>).detail)
    window.addEventListener(OUTLINE_LINK_PEEK_EVENT, listener)
    disposals.push(() => window.removeEventListener(OUTLINE_LINK_PEEK_EVENT, listener))
    const pos = findBullet(a.editor.state.doc, 'alpha')!.pos + 2
    a.editor.view.dispatch(a.editor.state.tr.insert(pos, a.editor.schema.text('Website ', [a.editor.schema.marks.link.create({ href: 'https://example.test/page' })])))
    const link = a.editor.view.dom.querySelector('a[href="https://example.test/page"]')!
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, metaKey: true }))
    expect(requests).toEqual([{ href: 'https://example.test/page', sourceNodeId: 'alpha', sourcePaneId: 'primary' }])
    expect(openUrl).toHaveBeenCalledWith('https://example.test/page')
  })

  it('rejects cross-pane drag targets and cleans the owner drag on teardown', () => {
    const { workspace, attach, a, capture } = fixture()
    const bId = workspace.openRight('primary', { kind: 'outline', nodeId: null })!
    const b = attach(bId)
    const source = a.editor.view.dom.querySelector('[data-node-id="alpha"] > .bullet-controls .bullet-dot')!
    const target = b.editor.view.dom.querySelector('[data-node-id="beta"] > p')!
    vi.spyOn(document, 'elementFromPoint').mockReturnValue(target)
    source.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 0, clientY: 0 }))
    document.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, cancelable: true, clientX: 10, clientY: 15 }))
    expect(document.body.classList.contains('is-dragging-outline')).toBe(true)
    expect(target.closest('li')!.hasAttribute('data-drop-placement')).toBe(false)
    document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true, clientX: 10, clientY: 15 }))
    expect(capture).not.toHaveBeenCalled()
    source.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 0, clientY: 0 }))
    document.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, cancelable: true, clientX: 10, clientY: 15 }))
    a.editor.destroy()
    expect(document.querySelector('.outline-drag-ghost')).toBeNull()
    expect(document.querySelector('.outline-drop-preview')).toBeNull()
    expect(document.body.classList.contains('is-dragging-outline')).toBe(false)
    document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true, clientX: 10, clientY: 15 }))
    expect(capture).not.toHaveBeenCalled()
  })
})
