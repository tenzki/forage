import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { BulletAttributes } from '../../editor/extensions'
import {
  getOutlinerUiState,
  OUTLINER_OPEN_SEARCH_EVENT,
  OUTLINER_POINTER_DRAG_EVENT,
  OutlinerUi,
} from '../../editor/outlinerUi'
import { OUTLINE_TAG_EVENT } from '../../editor/tags'
import { OutlinerSidebar } from './OutlinerSidebar'

function makeEditor(): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit.configure({ trailingNode: false }), BulletAttributes, OutlinerUi],
    content: {
      type: 'doc',
      content: [{
        type: 'bulletList',
        content: [{
          type: 'listItem',
          attrs: { nodeId: 'alpha', nodeType: 'user', collapsed: false },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Alpha #research' }] }],
        }],
      }],
    },
  })
}

describe('outliner sidebar', () => {
  let editor: Editor

  beforeEach(() => { editor = makeEditor() })
  afterEach(() => editor.destroy())

  it('opens node and tag shortcuts and can add an existing tag', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const onTag = vi.fn()
    window.addEventListener(OUTLINE_TAG_EVENT, onTag, { once: true })
    render(
      <OutlinerSidebar
        editor={editor}
        shortcuts={[
          { type: 'node', target: 'alpha' },
          { type: 'tag', target: 'research' },
        ]}
        onChange={onChange}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Alpha #research' }))
    expect(getOutlinerUiState(editor).zoomId).toBe('alpha')
    const tagShortcut = screen.getByRole('button', { name: '#research' })
    expect(tagShortcut.textContent).toBe('research')
    await user.click(tagShortcut)
    expect(onTag).toHaveBeenCalledOnce()

    await user.click(screen.getByRole('button', { name: 'Remove #research shortcut' }))
    expect(onChange).toHaveBeenCalledWith([{ type: 'node', target: 'alpha' }])
  })

  it('opens a named saved search from the sidebar', async () => {
    const user = userEvent.setup()
    const onSearch = vi.fn()
    window.addEventListener(OUTLINER_OPEN_SEARCH_EVENT, onSearch, { once: true })
    render(
      <OutlinerSidebar
        editor={editor}
        shortcuts={[{
          type: 'search',
          target: 'is:open',
          label: 'Open tasks',
          scopeId: 'alpha',
        }]}
        onChange={vi.fn()}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Open tasks' }))

    expect(onSearch).toHaveBeenCalledOnce()
    expect((onSearch.mock.calls[0][0] as CustomEvent).detail).toEqual({
      query: 'is:open',
      scopeId: 'alpha',
    })
  })

  it('searches both tags and nodes from the add menu', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(<OutlinerSidebar editor={editor} shortcuts={[]} onChange={onChange} />)

    await user.click(screen.getByRole('button', { name: 'Add shortcut' }))
    const search = screen.getByLabelText('Search nodes and tags')
    const tagCandidate = screen.getByRole('button', { name: '#research' })
    expect(tagCandidate.textContent).toContain('research')
    expect(tagCandidate.textContent).not.toContain('#research')
    expect(screen.getByText('Alpha #research')).toBeTruthy()
    await user.type(search, 'research')
    await user.click(tagCandidate)

    expect(onChange).toHaveBeenCalledWith([{ type: 'tag', target: 'research' }])
  })

  it('keeps Home, Settings, and Trash available when the sidebar is collapsed', async () => {
    const user = userEvent.setup()
    const onTrash = vi.fn()
    const onSettings = vi.fn()
    const view = render(
      <OutlinerSidebar
        editor={editor}
        shortcuts={[]}
        trashCount={2}
        onChange={vi.fn()}
        onOpenSettings={onSettings}
        onOpenTrash={onTrash}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Settings' }))
    expect(onSettings).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'Trash' }).closest('.sidebar-bottom')).toBeTruthy()
    view.rerender(
      <OutlinerSidebar
        editor={editor}
        shortcuts={[]}
        collapsed
        trashCount={2}
        onChange={vi.fn()}
        onOpenSettings={onSettings}
        onOpenTrash={onTrash}
      />,
    )
    expect(screen.queryByRole('heading', { name: 'Shortcuts' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Settings' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Home' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Trash' }))
    expect(onTrash).toHaveBeenCalledOnce()
  })

  it('reorders shortcuts by dragging their reorder grip', () => {
    const onChange = vi.fn()
    render(
      <OutlinerSidebar
        editor={editor}
        shortcuts={[
          { type: 'tag', target: 'research' },
          { type: 'node', target: 'alpha' },
        ]}
        onChange={onChange}
      />,
    )
    const target = document.querySelector<HTMLElement>('[data-shortcut-index="1"]')!
    target.getBoundingClientRect = () => ({ top: 0, height: 20 } as DOMRect)
    const hitTest = vi.spyOn(document, 'elementFromPoint').mockReturnValue(target)
    const grip = screen.getByRole('button', { name: 'Reorder #research' })

    act(() => {
      grip.dispatchEvent(new MouseEvent('pointerdown', {
        bubbles: true, cancelable: true, button: 0, clientX: 0, clientY: 0,
      }))
      document.dispatchEvent(new MouseEvent('pointermove', {
        bubbles: true, cancelable: true, clientX: 10, clientY: 15,
      }))
      document.dispatchEvent(new MouseEvent('pointerup', {
        bubbles: true, cancelable: true, clientX: 10, clientY: 15,
      }))
    })
    hitTest.mockRestore()

    expect(onChange).toHaveBeenCalledWith([
      { type: 'node', target: 'alpha' },
      { type: 'tag', target: 'research' },
    ])
  })

  it('adds a dragged node when it is dropped on the sidebar', () => {
    const onChange = vi.fn()
    render(<OutlinerSidebar editor={editor} shortcuts={[]} onChange={onChange} />)
    const sidebar = screen.getByLabelText('Outline sidebar')
    vi.spyOn(sidebar, 'getBoundingClientRect').mockReturnValue({
      left: 0, right: 220, top: 0, bottom: 600, width: 220, height: 600,
      x: 0, y: 0, toJSON: () => ({}),
    })

    act(() => window.dispatchEvent(new CustomEvent(OUTLINER_POINTER_DRAG_EVENT, {
      detail: { phase: 'move', nodeId: 'alpha', clientX: 100, clientY: 100 },
    })))
    expect(sidebar.classList.contains('is-drop-target')).toBe(true)
    act(() => window.dispatchEvent(new CustomEvent(OUTLINER_POINTER_DRAG_EVENT, {
      detail: { phase: 'drop', nodeId: 'alpha', clientX: 100, clientY: 100 },
    })))

    expect(onChange).toHaveBeenCalledWith([{ type: 'node', target: 'alpha' }])
  })
})
