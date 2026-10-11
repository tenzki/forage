import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { TwoViewPrototype } from './TwoViewPrototype'

afterEach(cleanup)

it('preserves composition DOM input through another view update and compositionend', async () => {
  const { container } = render(<TwoViewPrototype />)
  const [a, b] = Array.from(container.querySelectorAll<HTMLElement>('.ProseMirror'))
  b.focus()
  fireEvent.compositionStart(b)
  const appendInput = (view: HTMLElement, text: string, composing = false) => {
    const node = view.querySelector('p')!.firstChild!
    node.textContent += text
    const range = document.createRange()
    range.setStart(node, node.textContent!.length)
    range.collapse(true)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    fireEvent.input(view, { inputType: composing ? 'insertCompositionText' : 'insertText', data: text, isComposing: composing })
  }
  appendInput(b, '日本', true)
  await waitFor(() => expect(b.textContent).toContain('日本'))
  // Programmatic DOM input in A leaves native focus on the composing view B.
  appendInput(a, ' another view')
  await waitFor(() => expect(container.textContent).toContain('captured changes 1'))
  expect(b.textContent).not.toContain('another view')
  expect(document.activeElement).toBe(b)
  fireEvent.compositionEnd(b, { data: '日本' })
  await waitFor(() => expect(a.textContent).toBe(b.textContent))
  expect(a.textContent).toContain('日本')
  expect(a.textContent).toContain('another view')
  expect(document.activeElement).toBe(b)
  expect(container.textContent).toContain('captured changes 2')
})
