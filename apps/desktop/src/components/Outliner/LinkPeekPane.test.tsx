import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({
  invoke: vi.fn(async (..._args: unknown[]) => undefined),
  pageState: null as ((event: { payload: unknown }) => void) | null,
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke, isTauri: () => true }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_event: string, handler: (event: { payload: unknown }) => void) => {
    native.pageState = handler
    return () => undefined
  }),
}))
vi.mock('../../editor/readerDocument', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../editor/readerDocument')>()),
  fetchReaderDocument: vi.fn(async (href: string) => ({
    href,
    host: new URL(href).hostname,
    title: 'Reader title',
    blocks: [],
    minutes: 1,
    fetchedAt: 0,
  })),
}))

import { fetchReaderDocument } from '../../editor/readerDocument'
import { LinkPeekPane } from './LinkPeekPane'

function calls(command: string) {
  return native.invoke.mock.calls.filter(([name]) => name === command)
}

describe('LinkPeekPane page mode', () => {
  beforeEach(() => {
    // jsdom does not implement element scrolling.
    Element.prototype.scrollTo ??= () => undefined
    native.invoke.mockClear()
    vi.mocked(fetchReaderDocument).mockClear()
    native.pageState = null
  })

  it('opens on the live page and follows its navigation', async () => {
    const { unmount } = render(
      <LinkPeekPane editor={null} href="https://example.com/start" onClose={() => undefined} />,
    )
    // Loading starts straight away; the page is shown once the pane settles.
    expect(calls('page_peek_load')[0]![1]).toEqual({ url: 'https://example.com/start' })
    await waitFor(() => expect(calls('page_peek_show')).toHaveLength(1))
    expect(screen.getByText('Live page')).toBeTruthy()
    // The reader is not fetched until it is asked for.
    expect(fetchReaderDocument).not.toHaveBeenCalled()

    // The pane slides in without resizing; the page must follow it anyway.
    const surface = document.querySelector('.link-peek-page')!
    surface.getBoundingClientRect = () => ({ left: 500, top: 60, width: 400, height: 700 }) as DOMRect
    await waitFor(() => expect(calls('page_peek_set_bounds').some(([, args]) =>
      (args as { bounds: { x: number } }).bounds.x === 500)).toBe(true))

    await waitFor(() => expect(native.pageState).not.toBeNull())
    act(() => native.pageState!({ payload: { url: 'https://other.org/next', loading: false, title: null } }))
    expect(screen.getByText('other.org')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(calls('page_peek_navigate')[0]![1]).toEqual({ action: 'back' })

    // To the reader: the live view hides and the reader shows the same page.
    fireEvent.click(screen.getByRole('button', { name: 'Reader' }))
    await waitFor(() => {
      const visibility = calls('page_peek_set_visible')
      expect(visibility[visibility.length - 1]?.[1]).toEqual({ visible: false })
    })
    await waitFor(() => expect(document.querySelector('.link-peek-meta')?.textContent).toBe('other.org  ·  1 min read'))
    expect(fetchReaderDocument).toHaveBeenCalledTimes(1)

    // Back and forth again does not fetch the reader a second time.
    fireEvent.click(screen.getByRole('button', { name: 'Page' }))
    fireEvent.click(screen.getByRole('button', { name: 'Reader' }))
    await screen.findByRole('heading', { name: 'Reader title' })
    expect(fetchReaderDocument).toHaveBeenCalledTimes(1)

    unmount()
    expect(calls('page_peek_close')).toHaveLength(1)
  })

  it('leaves a picture of the page in its place while a dialog is up', async () => {
    URL.createObjectURL ??= () => ''
    URL.revokeObjectURL ??= () => undefined
    const created = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:still')
    const revoked = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    native.invoke.mockImplementation(async (command: unknown) =>
      (command === 'page_peek_snapshot' ? new ArrayBuffer(4) : undefined) as never)

    const { container, unmount } = render(
      <LinkPeekPane editor={null} href="https://example.com/start" onClose={() => undefined} />,
    )
    await waitFor(() => expect(calls('page_peek_show')).toHaveLength(1))

    const dialog = document.createElement('div')
    dialog.setAttribute('aria-modal', 'true')
    document.body.append(dialog)
    // The picture is taken before the page goes, and shown where it was.
    await waitFor(() => expect(container.querySelector('.link-peek-page-still')?.getAttribute('src')).toBe('blob:still'))
    expect(calls('page_peek_snapshot')).toHaveLength(1)
    const visibility = () => calls('page_peek_set_visible').map(([, args]) => args)
    await waitFor(() => expect(visibility()).toEqual([{ visible: false }]))

    dialog.remove()
    await waitFor(() => expect(visibility()).toEqual([{ visible: false }, { visible: true }]))
    await waitFor(() => expect(container.querySelector('.link-peek-page-still')).toBeNull())
    expect(revoked).toHaveBeenCalledWith('blob:still')

    unmount()
    created.mockRestore()
    revoked.mockRestore()
    native.invoke.mockImplementation(async () => undefined)
  })
})
