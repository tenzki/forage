import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { BulletAttributes, OutlinerKeymap } from '../../editor/extensions'
import { BulletNote } from '../../editor/bulletNote'
import {
  collectBullets,
  setBulletKind,
  toggleBulletCompleted,
} from '../../editor/outlineModel'
import { OutlinerUi } from '../../editor/outlinerUi'
import { OutlinerChrome } from './OutlinerChrome'

function makeEditor(): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit.configure({ trailingNode: false }), BulletAttributes, BulletNote, OutlinerKeymap, OutlinerUi],
    content: {
      type: 'doc',
      content: [{
        type: 'bulletList',
        content: [{
          type: 'listItem',
          attrs: { nodeId: 'alpha', nodeType: 'user', collapsed: false },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Alpha note' }] }],
        }],
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

  it('edits a matching bullet directly from search results', async () => {
    const user = userEvent.setup()
    render(<OutlinerChrome editor={editor} trash={[]} onTrashChange={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: /Search/ }))
    await user.type(screen.getByLabelText('Search bullets'), 'Alpha')
    const result = screen.getByLabelText('Edit Alpha note')
    await user.clear(result)
    await user.type(result, 'Renamed note')
    await user.tab()

    expect(collectBullets(editor.state.doc)[0].text).toBe('Renamed note')
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
    await user.type(screen.getByLabelText('Search bullets'), 'Supporting')

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
    await user.type(screen.getByLabelText('Search bullets'), 'is:complete')

    expect(screen.getByLabelText('Edit Alpha note')).toBeTruthy()
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
    await user.type(screen.getByLabelText('Search bullets'), 'Alpha')
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
