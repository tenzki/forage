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

import { LinkPeekPane } from './LinkPeekPane'

function calls(command: string) {
  return native.invoke.mock.calls.filter(([name]) => name === command)
}

describe('LinkPeekPane page mode', () => {
  beforeEach(() => {
    // jsdom does not implement element scrolling.
    Element.prototype.scrollTo ??= () => undefined
    native.invoke.mockClear()
    native.pageState = null
  })

  it('shows the live page in the pane and follows its navigation', async () => {
    const { unmount } = render(
      <LinkPeekPane editor={null} href="https://example.com/start" onClose={() => undefined} />,
    )
    await screen.findByRole('heading', { name: 'Reader title' })
    expect(calls('page_peek_open')).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: 'Page' }))
    await waitFor(() => expect(calls('page_peek_open')).toHaveLength(1))
    expect(calls('page_peek_open')[0]![1]).toMatchObject({ url: 'https://example.com/start' })
    expect(screen.getByText('Live page')).toBeTruthy()

    await waitFor(() => expect(native.pageState).not.toBeNull())
    act(() => native.pageState!({ payload: { url: 'https://other.org/next', loading: false, title: null } }))
    expect(screen.getByText('other.org')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(calls('page_peek_navigate')[0]![1]).toEqual({ action: 'back' })

    // Back to the reader: the live view hides and the reader follows the page.
    fireEvent.click(screen.getByRole('button', { name: 'Reader' }))
    await waitFor(() => {
      const visibility = calls('page_peek_set_visible')
      expect(visibility[visibility.length - 1]?.[1]).toEqual({ visible: false })
    })
    await waitFor(() => expect(document.querySelector('.link-peek-meta')?.textContent).toBe('other.org  ·  1 min read'))

    unmount()
    expect(calls('page_peek_close')).toHaveLength(1)
  })
})
