import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import SearchOverlay from './SearchOverlay'

// Mock the IPC functions to avoid actual Tauri calls in tests.
vi.mock('../../store/ipc', () => ({
  searchNodesIpc: vi.fn().mockResolvedValue([]),
  getAncestorsIpc: vi.fn().mockResolvedValue([]),
}))

// Mock the treeStore to avoid Tauri window calls.
vi.mock('../../store/treeStore', () => ({
  useTreeStore: {
    getState: () => ({
      zoomIn: vi.fn(),
    }),
  },
}))

describe('SearchOverlay', () => {
  const onCloseMock = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders nothing visible when open is false', () => {
    const { container } = render(
      <SearchOverlay open={false} onClose={onCloseMock} />
    )
    // cmdk dialog is not rendered when open=false
    const dialog = container.querySelector('[cmdk-dialog]')
    expect(dialog).toBeNull()
  })

  it('renders the cmdk dialog when open is true', () => {
    render(<SearchOverlay open={true} onClose={onCloseMock} />)
    // The input placeholder should be visible
    const input = screen.getByPlaceholderText('Search all nodes...')
    expect(input).toBeTruthy()
  })

  it('shows "No results found." when query has no matches', async () => {
    const { searchNodesIpc } = await import('../../store/ipc')
    vi.mocked(searchNodesIpc).mockResolvedValue([])

    render(<SearchOverlay open={true} onClose={onCloseMock} />)

    const input = screen.getByPlaceholderText('Search all nodes...')
    fireEvent.change(input, { target: { value: 'nonexistent query xyz' } })

    await waitFor(
      () => {
        expect(screen.getByText('No results found.')).toBeTruthy()
      },
      { timeout: 500 }
    )
  })

  it('calls onClose when dialog closes (Escape key)', async () => {
    render(<SearchOverlay open={true} onClose={onCloseMock} />)

    const input = screen.getByPlaceholderText('Search all nodes...')
    fireEvent.keyDown(input, { key: 'Escape', code: 'Escape' })

    // cmdk handles Escape internally and calls onOpenChange(false)
    // which should trigger our onClose callback
    await waitFor(() => {
      expect(onCloseMock).toHaveBeenCalled()
    })
  })

  it('displays search results when searchNodesIpc returns data', async () => {
    vi.useFakeTimers()

    const { searchNodesIpc, getAncestorsIpc } = await import('../../store/ipc')

    vi.mocked(searchNodesIpc).mockResolvedValue([
      {
        id: 'test-node-1',
        parentId: null,
        nodeType: 'note',
        snippet: 'The <mark>quick</mark> brown fox',
      },
    ])
    vi.mocked(getAncestorsIpc).mockResolvedValue([])

    render(<SearchOverlay open={true} onClose={onCloseMock} />)

    const input = screen.getByPlaceholderText('Search all nodes...')
    fireEvent.change(input, { target: { value: 'quick' } })

    // Advance timers past the 200ms debounce
    await vi.runAllTimersAsync()

    vi.useRealTimers()

    await waitFor(
      () => {
        // Result item should be rendered — check for the cmdk item or snippet container
        const items = document.querySelectorAll('[cmdk-item]')
        expect(items.length).toBeGreaterThan(0)
      },
      { timeout: 1000 }
    )

    // Snippet is rendered via dangerouslySetInnerHTML
    const snippetEl = document.querySelector('.search-result-snippet')
    expect(snippetEl).toBeTruthy()
    expect(snippetEl?.innerHTML).toContain('<mark>quick</mark>')
  })
})
