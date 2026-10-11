import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { EditorState, Plugin, TextSelection } from '@tiptap/pm/state'
import { EditorView } from '@tiptap/pm/view'
import { BulletAttributes } from '../extensions'
import { captureDocumentEvent } from '../eventCapture'
import { DocumentCoordinator } from './DocumentCoordinator'

const cleanup: (() => void)[] = []
afterEach(() => { cleanup.splice(0).reverse().forEach(fn => fn()) })
function setup() {
  const editor = new Editor({ extensions: [StarterKit.configure({ undoRedo: false }), BulletAttributes],
    content: '<ul><li><p>hello</p></li></ul>' })
  cleanup.push(() => editor.destroy())
  const normalized = editor.state.applyTransaction(editor.state.tr.insertText('!', 3)).state
  const capture = vi.fn((root, appended) => captureDocumentEvent(root, appended, {
    outlineId: 'outline', actorId: 'actor', deviceId: 'device', baseRevision: 0,
    nextEventId: () => 'event', nextChangeGroupId: () => 'group',
  }))
  const normalize = vi.fn(() => null)
  const canonical = EditorState.create({ doc: normalized.doc, plugins: [...normalized.plugins, new Plugin({ appendTransaction: normalize })] })
  const coordinator = new DocumentCoordinator(canonical, capture)
  const views = ['a', 'b'].map(id => {
    const element = document.body.appendChild(document.createElement('div'))
    const view = new EditorView(element, {
      state: EditorState.create({ doc: canonical.doc, plugins: canonical.plugins }),
      dispatchTransaction: tr => { coordinator.dispatch(id, tr) },
    })
    coordinator.attach(id, view)
    cleanup.push(() => { view.destroy(); element.remove() })
    return view
  })
  normalize.mockClear()
  capture.mockClear()
  return { coordinator, a: views[0], b: views[1], capture, normalize }
}

describe('two full-document view feasibility', () => {
  it('normalizes identity once and captures the complete root/appended batch once', () => {
    const { coordinator, a, b, capture, normalize } = setup()
    const id = a.state.doc.firstChild!.firstChild!.attrs.nodeId
    const item = a.state.schema.nodes.listItem.create(null, a.state.schema.nodes.paragraph.create())
    a.dispatch(a.state.tr.insert(a.state.doc.content.size - 1, item))
    const ids: string[] = []
    coordinator.state.doc.descendants(node => { if (node.type.name === 'listItem') ids.push(node.attrs.nodeId) })
    expect(ids[0]).toBe(id)
    expect(ids.every(Boolean)).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
    expect(capture).toHaveBeenCalledTimes(1)
    expect(capture.mock.results[0].value!.after).toEqual(coordinator.state.doc.toJSON())
    expect(capture.mock.calls[0][1].some((tr: { docChanged: boolean }) => tr.docChanged)).toBe(true)
    expect(normalize).toHaveBeenCalledTimes(1)
    expect(a.state.doc.eq(b.state.doc)).toBe(true)
  })

  it('maps an inactive caret without stealing focus or requesting scroll', () => {
    const { a, b } = setup()
    b.dispatch(b.state.tr.setSelection(TextSelection.create(b.state.doc, 5)))
    a.focus()
    const focus = document.activeElement
    a.dispatch(a.state.tr.insertText('xx', 3))
    expect(b.state.selection.from).toBe(7)
    expect(document.activeElement).toBe(focus)
    expect((b.state as unknown as { scrollToSelection: number }).scrollToSelection).toBe(0)
  })

  it('rebases stale typed text without overwriting another view', () => {
    const { coordinator, a, b, capture } = setup()
    const stale = b.state.tr.insertText('B', 5)
    a.dispatch(a.state.tr.insertText('AA', 3))
    expect(coordinator.dispatch('b', stale, 0).accepted).toBe(true)
    expect(a.state.doc.textContent).toContain('AA')
    expect(a.state.doc.textContent).toContain('B')
    expect(a.state.doc.eq(b.state.doc)).toBe(true)
    expect(capture).toHaveBeenCalledTimes(2)
  })

  it('maps composition replacements through multiple intervening commits', () => {
    const { coordinator, a, b } = setup()
    coordinator.beginComposition('b')
    b.dispatch(b.state.tr.insertText('に', 5))
    a.dispatch(a.state.tr.insertText('one', 3))
    a.dispatch(a.state.tr.insertText('two', 3))
    b.dispatch(b.state.tr.insertText('日本', 5, 6))
    expect(coordinator.endComposition('b').accepted).toBe(true)
    expect(a.state.doc.textContent).toContain('日本')
    expect(a.state.doc.textContent).toContain('twoone')
    expect(a.state.doc.eq(b.state.doc)).toBe(true)
  })

  it('clamps an inactive selection when its content is deleted', () => {
    const { a, b } = setup()
    b.dispatch(b.state.tr.setSelection(TextSelection.create(b.state.doc, 6)))
    a.focus()
    a.dispatch(a.state.tr.delete(3, 8))
    expect(b.state.selection.from).toBe(3)
    expect(b.state.selection.$from.parent.isTextblock).toBe(true)
    expect(document.activeElement).toBe(a.dom)
  })

  it('rejects a mismatched revision and returns recoverable input', () => {
    const { coordinator, a, b, capture } = setup()
    const stale = b.state.tr.insertText('retained', 4)
    a.dispatch(a.state.tr.insertText('new', 3))
    const result = coordinator.dispatch('b', stale, 1)
    expect(result.accepted).toBe(false)
    if (!result.accepted) expect(result.pending.doc.textContent).toContain('retained')
    expect(capture).toHaveBeenCalledTimes(1)
    expect(a.state.doc.eq(b.state.doc)).toBe(true)
  })

  it('defers projection during composition, then reconciles all typed steps', () => {
    const { coordinator, a, b, capture } = setup()
    b.focus()
    const focus = document.activeElement
    coordinator.beginComposition('b')
    b.dispatch(b.state.tr.insertText('に', 5))
    a.dispatch(a.state.tr.insertText('remote', 3))
    expect(b.state.doc.textContent).not.toContain('remote')
    b.dispatch(b.state.tr.insertText('ほん', 6))
    expect(coordinator.endComposition('b').accepted).toBe(true)
    expect(a.state.doc.textContent).toContain('にほん')
    expect(a.state.doc.textContent).toContain('remote')
    expect(a.state.doc.eq(b.state.doc)).toBe(true)
    expect(document.activeElement).toBe(focus)
    expect(capture).toHaveBeenCalledTimes(2)
  })

  it('retains conflicting composition text and DOM for explicit recovery', () => {
    const { coordinator, a, b, capture } = setup()
    coordinator.beginComposition('b')
    b.dispatch(b.state.tr.insertText('keep me', 5))
    a.dispatch(a.state.tr.delete(0, a.state.doc.content.size))
    const result = coordinator.endComposition('b')
    expect(result.accepted).toBe(false)
    expect(b.state.doc.textContent).toContain('keep me')
    expect(b.dom.textContent).toContain('keep me')
    expect(capture).toHaveBeenCalledTimes(1)
  })

  it('projects a compensating transaction once across both views', () => {
    const { coordinator, a, b, capture } = setup()
    const before = a.state.doc
    a.dispatch(a.state.tr.insertText('edit', 3))
    const batch = capture.mock.calls[0]
    const transactions = [batch[0], ...batch[1]]
    const undo = b.state.tr
    for (const tr of transactions.reverse()) for (let i = tr.steps.length - 1; i >= 0; i--) undo.step(tr.steps[i].invert(tr.docs[i]))
    undo.setMeta('forageCompensation', { type: 'document.undo_applied', targetEventIds: ['event'] })
    b.dispatch(undo)
    expect(coordinator.state.doc.eq(before)).toBe(true)
    expect(a.state.doc.eq(b.state.doc)).toBe(true)
    expect(capture).toHaveBeenCalledTimes(2)
    expect(capture.mock.results[1].value!.type).toBe('document.undo_applied')
  })
})
