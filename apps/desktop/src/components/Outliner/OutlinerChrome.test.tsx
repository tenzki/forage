import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { BulletAttributes, OutlinerKeymap } from '../../editor/extensions'
import { BulletNote } from '../../editor/bulletNote'
import {
  collectBullets,
  setBulletKind,
  toggleBulletCompleted,
  updateBulletText,
} from '../../editor/outlineModel'
import { getOutlinerUiState, OutlinerUi, setZoom } from '../../editor/outlinerUi'
import { OutlinerChrome } from './OutlinerChrome'

function makeEditor(): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit.configure({ trailingNode: false }), BulletAttributes, BulletNote, OutlinerKeymap, OutlinerUi],
    content: {
      type: 'doc',
      content: [{
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            attrs: { nodeId: 'alpha', nodeType: 'user', collapsed: false },
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Alpha note' }] }],
          },
          {
            type: 'listItem',
            attrs: { nodeId: 'bravo', nodeType: 'user', collapsed: false },
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Bravo note' }] }],
          },
        ],
      }],
    },
  })
}

describe('outliner chrome', () => {
  let editor: Editor

  beforeEach(() => {
    editor = makeEditor()
    document.body.appendChild(editor.view.dom)
  })

  afterEach(() => {
    editor.view.dom.remove()
    editor.destroy()
  })

  it('opens a matching bullet instead of editing it in the search popup', async () => {
    const user = userEvent.setup()
    render(<OutlinerChrome editor={editor} trash={[]} onTrashChange={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /Search/ }))
    await user.type(screen.getByLabelText('Search commands and bullets'), 'Alpha')

    expect(screen.queryByRole('textbox', { name: /Edit Alpha/ })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Open Alpha note' }))

    expect(getOutlinerUiState(editor).zoomId).toBe('alpha')
    expect(screen.queryByRole('dialog', { name: 'Search outline' })).toBeNull()
  })

  it('searches the whole document while focused on a node', async () => {
    const user = userEvent.setup()
    setZoom(editor, 'alpha')
    render(<OutlinerChrome editor={editor} trash={[]} onTrashChange={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: /Search/ }))
    await user.type(screen.getByLabelText('Search commands and bullets'), 'Bravo')

    expect(screen.getByRole('button', { name: 'Open Bravo note' })).toBeTruthy()
  })

  it('finds bullets without requiring diacritic characters', async () => {
    const user = userEvent.setup()
    updateBulletText(editor, 'alpha', 'Bojan Babić')
    render(<OutlinerChrome editor={editor} trash={[]} onTrashChange={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: /Search/ }))
    await user.type(screen.getByLabelText('Search commands and bullets'), 'Bojan Babic')

    expect(screen.getByRole('button', { name: 'Open Bojan Babić' })).toBeTruthy()
  })

  it('navigates backward and forward with toolbar buttons and shortcuts', async () => {
    const user = userEvent.setup()
    setZoom(editor, 'alpha')
    setZoom(editor, 'bravo')
    render(<OutlinerChrome editor={editor} trash={[]} onTrashChange={vi.fn()} />)

    const back = screen.getByRole('button', { name: 'Go back' })
    const forward = screen.getByRole('button', { name: 'Go forward' })
    expect(back.getAttribute('aria-keyshortcuts')).toBe('Meta+[ Control+[')
    await user.click(back)
    expect(getOutlinerUiState(editor).zoomId).toBe('alpha')

    await user.click(forward)
    expect(getOutlinerUiState(editor).zoomId).toBe('bravo')

    fireEvent.keyDown(window, { key: '[', metaKey: true })
    expect(getOutlinerUiState(editor).zoomId).toBe('alpha')
    fireEvent.keyDown(window, { key: ']', metaKey: true })
    expect(getOutlinerUiState(editor).zoomId).toBe('bravo')
  })

  it('returns home from the command menu', async () => {
    const user = userEvent.setup()
    setZoom(editor, 'alpha')
    render(<OutlinerChrome editor={editor} trash={[]} onTrashChange={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: /Search/ }))
    await user.type(screen.getByLabelText('Search commands and bullets'), 'home')
    await user.keyboard('{Enter}')

    expect(getOutlinerUiState(editor).zoomId).toBeNull()
  })

  it('opens Settings and Trash from the command menu', async () => {
    const user = userEvent.setup()
    const onOpenSettings = vi.fn()
    const onOpenTrash = vi.fn()
    render(
      <OutlinerChrome
        editor={editor}
        trash={[]}
        onTrashChange={vi.fn()}
        onOpenSettings={onOpenSettings}
        onOpenTrash={onOpenTrash}
      />,
    )

    await user.click(screen.getByRole('button', { name: /Search/ }))
    await user.type(screen.getByLabelText('Search commands and bullets'), 'settings')
    await user.keyboard('{Enter}')
    expect(onOpenSettings).toHaveBeenCalledOnce()

    await user.click(screen.getByRole('button', { name: /Search/ }))
    await user.type(screen.getByLabelText('Search commands and bullets'), 'trash')
    await user.keyboard('{Enter}')
    expect(onOpenTrash).toHaveBeenCalledOnce()
  })

  it('converts a bullet to a todo from its action menu', async () => {
    const user = userEvent.setup()
    render(<OutlinerChrome editor={editor} trash={[]} onTrashChange={vi.fn()} />)
    const menuButton = editor.view.dom.querySelector('.bullet-menu') as HTMLButtonElement

    await user.click(menuButton)
    await user.click(screen.getByRole('menuitem', { name: 'Convert to todo' }))

    expect(collectBullets(editor.state.doc)[0]).toMatchObject({
      bulletKind: 'todo',
      completed: false,
    })
    expect(editor.view.dom.querySelector('.todo-checkbox')).toBeTruthy()
  })

  it('adds a searchable secondary note from the node menu', async () => {
    const user = userEvent.setup()
    render(<OutlinerChrome editor={editor} trash={[]} onTrashChange={vi.fn()} />)
    const menuButton = editor.view.dom.querySelector('.bullet-menu') as HTMLButtonElement

    await user.click(menuButton)
    await user.click(screen.getByRole('menuitem', { name: 'Add note' }))
    expect(document.activeElement).toBe(editor.view.dom)
    expect(editor.state.selection.$from.parent.type.name).toBe('bulletNote')
    act(() => { editor.commands.insertContent('Supporting context') })
    await user.click(screen.getByRole('button', { name: /Search/ }))
    await user.type(screen.getByLabelText('Search commands and bullets'), 'Supporting')

    expect(screen.getByText(/Note: Supporting context/)).toBeTruthy()
  })

  it('searches completion status and hides completed todos', async () => {
    const user = userEvent.setup()
    setBulletKind(editor, 'alpha', 'todo')
    toggleBulletCompleted(editor, 'alpha')
    render(<OutlinerChrome editor={editor} trash={[]} onTrashChange={vi.fn()} />)

    await user.click(screen.getByRole('button', { name: 'Hide completed' }))
    expect(editor.view.dom.querySelector('[data-node-id="alpha"]')?.classList.contains('is-completed-hidden')).toBe(true)
    await user.click(screen.getByRole('button', { name: /Search/ }))
    await user.type(screen.getByLabelText('Search commands and bullets'), 'is:complete')

    expect(screen.getByRole('button', { name: 'Open Alpha note' })).toBeTruthy()
  })

  it('saves a named search to sidebar shortcuts', async () => {
    const user = userEvent.setup()
    const onShortcutsChange = vi.fn()
    render(
      <OutlinerChrome
        editor={editor}
        trash={[]}
        onTrashChange={vi.fn()}
        onShortcutsChange={onShortcutsChange}
      />,
    )

    await user.click(screen.getByRole('button', { name: /Search/ }))
    await user.type(screen.getByLabelText('Search commands and bullets'), 'Alpha')
    await user.click(screen.getByRole('button', { name: 'Save search' }))
    await user.type(screen.getByLabelText('Saved search name'), 'Alpha items')
    await user.click(screen.getByRole('button', { name: /^Save$/ }))

    expect(onShortcutsChange).toHaveBeenCalledWith([{
      type: 'search',
      target: 'Alpha',
      label: 'Alpha items',
      scopeId: null,
    }])
  })

  it('exposes the sidebar toggle in the outline toolbar', async () => {
    const user = userEvent.setup()
    const onToggleSidebar = vi.fn()
    render(
      <OutlinerChrome
        editor={editor}
        trash={[]}
        onTrashChange={vi.fn()}
        onToggleSidebar={onToggleSidebar}
      />,
    )

    await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }))

    expect(onToggleSidebar).toHaveBeenCalledOnce()
  })

  it('places the activity sidebar toggle immediately after Search', async () => {
    const user = userEvent.setup()
    const onToggleActivitySidebar = vi.fn()
    render(
      <OutlinerChrome
        editor={editor}
        trash={[]}
        onTrashChange={vi.fn()}
        onToggleActivitySidebar={onToggleActivitySidebar}
      />,
    )

    const activityToggle = screen.getByRole('button', { name: 'Collapse activity sidebar' })
    const searchButton = screen.getByRole('button', { name: /Search/ })
    expect(searchButton.nextElementSibling).toBe(activityToggle)
    await user.click(activityToggle)
    expect(onToggleActivitySidebar).toHaveBeenCalledOnce()
  })

  it('adds a node to sidebar shortcuts from its action menu', async () => {
    const user = userEvent.setup()
    const onShortcutsChange = vi.fn()
    render(
      <OutlinerChrome
        editor={editor}
        trash={[]}
        onTrashChange={vi.fn()}
        shortcuts={[]}
        onShortcutsChange={onShortcutsChange}
      />,
    )
    const menuButton = editor.view.dom.querySelector('.bullet-menu') as HTMLButtonElement
    await user.click(menuButton)
    await user.click(screen.getByRole('menuitem', { name: 'Add to shortcuts' }))

    expect(onShortcutsChange).toHaveBeenCalledWith([{ type: 'node', target: 'alpha' }])
  })

  it('exposes explicit branch actions and sends deletion to trash', async () => {
    const user = userEvent.setup()
    const onTrashChange = vi.fn()
    render(<OutlinerChrome editor={editor} trash={[]} onTrashChange={onTrashChange} />)
    const menuButton = editor.view.dom.querySelector('.bullet-menu') as HTMLButtonElement
    await user.click(menuButton)
    await user.click(screen.getByRole('menuitem', { name: 'Move to Trash' }))

    expect(onTrashChange).toHaveBeenCalledOnce()
    expect(onTrashChange.mock.calls[0][0]).toHaveLength(1)
    expect(collectBullets(editor.state.doc).some((entry) => entry.id === 'alpha')).toBe(false)
  })
})
