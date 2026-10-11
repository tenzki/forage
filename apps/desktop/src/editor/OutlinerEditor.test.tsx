import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { DocumentCoordinator } from './DocumentCoordinator'
import { OutlinerEditor } from './OutlinerEditor'
import { findBullet } from './outlineModel'

afterEach(cleanup)

it('reconciles production composition DOM after another pane edits and detaches only the closed view', async () => {
  const capture = vi.fn()
  const coordinator = new DocumentCoordinator({ type: 'doc', content: [{ type: 'bulletList', content: [{
    type: 'listItem', attrs: { nodeId: 'target' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Original' }] }],
  }] }] }, { onTransaction: capture })
  const views = (includeB: boolean) => <>
    <OutlinerEditor coordinator={coordinator} paneId="a" />
    {includeB && <OutlinerEditor coordinator={coordinator} paneId="b" />}
  </>
  const rendered = render(views(true))
  try {
    await waitFor(() => expect(rendered.container.querySelectorAll('.ProseMirror')).toHaveLength(2))
    const [a, b] = Array.from(rendered.container.querySelectorAll<HTMLElement>('.ProseMirror'))
    b.focus()
    fireEvent.compositionStart(b)
    const text = b.querySelector('[data-node-id="target"] p')!.firstChild!
    text.textContent += '日本'
    const range = document.createRange()
    range.setStart(text, text.textContent!.length)
    range.collapse(true)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    fireEvent.input(b, { inputType: 'insertCompositionText', data: '日本', isComposing: true })
    await waitFor(() => expect(b.textContent).toContain('日本'))
    act(() => {
      const owner = coordinator.editor
      owner.view.dispatch(owner.state.tr.insertText('Other ', findBullet(owner.state.doc, 'target')!.pos + 2))
    })
    expect(b.textContent).not.toContain('Other')
    expect(document.activeElement).toBe(b)
    fireEvent.compositionEnd(b, { data: '日本' })
    await waitFor(() => expect(a.textContent).toBe(b.textContent))
    expect(a.textContent).toContain('Other Original日本')
    expect(document.activeElement).toBe(b)
    expect(capture).toHaveBeenCalledTimes(2)
    rendered.rerender(views(false))
    expect(coordinator.editor.isDestroyed).toBe(false)
    expect(rendered.container.querySelectorAll('.ProseMirror')).toHaveLength(1)
    expect(a.textContent).toContain('日本')
  } finally {
    rendered.unmount()
    coordinator.destroy()
  }
})
