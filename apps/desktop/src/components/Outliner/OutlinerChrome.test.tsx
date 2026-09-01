import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { BulletAttributes, OutlinerKeymap } from '../../editor/extensions'
import { BulletNote } from '../../editor/bulletNote'
import {
  GeneratedImage,
  GeneratedImageItem,
  OutlineBulletList,
  OutlineListItem,
} from '../../editor/generatedImage'
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
    extensions: [
      StarterKit.configure({ bulletList: false, listItem: false, trailingNode: false }),
      OutlineListItem,
      OutlineBulletList,
      GeneratedImageItem,
      GeneratedImage,
      BulletAttributes,
      BulletNote,
      OutlinerKeymap,
      OutlinerUi,
    ],
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

  it('opens Inbox, Daily Notes, and Tasks from the command menu', async () => {
    const user = userEvent.setup()
    const onOpenInbox = vi.fn()
    const onOpenDailyNotes = vi.fn()
    const onOpenTasks = vi.fn()
    render(
      <OutlinerChrome
        editor={editor}
        trash={[]}
        onTrashChange={vi.fn()}
        onOpenInbox={onOpenInbox}
        onOpenDailyNotes={onOpenDailyNotes}
        onOpenTasks={onOpenTasks}
      />,
    )

    await user.click(screen.getByRole('button', { name: /Search/ }))
    await user.type(screen.getByLabelText('Search commands and bullets'), 'inbox')
    await user.keyboard('{Enter}')
    expect(onOpenInbox).toHaveBeenCalledOnce()

    await user.click(screen.getByRole('button', { name: /Search/ }))
    await user.type(screen.getByLabelText('Search commands and bullets'), 'daily notes')
    await user.keyboard('{Enter}')
    expect(onOpenDailyNotes).toHaveBeenCalledOnce()

    await user.click(screen.getByRole('button', { name: /Search/ }))
    await user.type(screen.getByLabelText('Search commands and bullets'), 'tasks')
    await user.keyboard('{Enter}')
    expect(onOpenTasks).toHaveBeenCalledOnce()
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

  it('surfaces non-destructive feedback when a protected root action is attempted', async () => {
    const user = userEvent.setup()
    const alpha = collectBullets(editor.state.doc).find((entry) => entry.id === 'alpha')!
    editor.view.dispatch(editor.state.tr.setNodeMarkup(alpha.pos, undefined, {
      ...alpha.node.attrs,
      systemRole: 'inbox',
    }))
    render(<OutlinerChrome editor={editor} trash={[]} onTrashChange={vi.fn()} />)
    const menuButton = editor.view.dom.querySelector('.bullet-menu') as HTMLButtonElement

    await user.click(menuButton)
    await user.click(screen.getByRole('menuitem', { name: 'Convert to todo' }))

    expect(screen.getByRole('alert').textContent).toContain('protected')
    expect(collectBullets(editor.state.doc).find((entry) => entry.id === 'alpha')?.bulletKind).toBe('bullet')
  })

  it('silently ignores moving a protected root to Trash', async () => {
    const user = userEvent.setup()
    const onTrashChange = vi.fn()
    const alpha = collectBullets(editor.state.doc).find((entry) => entry.id === 'alpha')!
    editor.view.dispatch(editor.state.tr.setNodeMarkup(alpha.pos, undefined, {
      ...alpha.node.attrs,
      systemRole: 'inbox',
    }))
    render(<OutlinerChrome editor={editor} trash={[]} onTrashChange={onTrashChange} />)
    const menuButton = editor.view.dom.querySelector('.bullet-menu') as HTMLButtonElement

    await user.click(menuButton)
    await user.click(screen.getByRole('menuitem', { name: 'Move to Trash' }))

    expect(screen.queryByRole('alert')).toBeNull()
    expect(onTrashChange).not.toHaveBeenCalled()
    expect(collectBullets(editor.state.doc).find((entry) => entry.id === 'alpha')).toBeTruthy()
  })

  it('moves a daily-note branch to Trash from its Home action menu', async () => {
    const user = userEvent.setup()
    const onTrashChange = vi.fn()
    editor.commands.setContent({
      type: 'doc',
      content: [{
        type: 'bulletList',
        content: [
          {
            type: 'listItem',
            attrs: { nodeId: 'inbox', nodeType: 'user', systemRole: 'inbox' },
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Inbox' }] }],
          },
          {
            type: 'listItem',
            attrs: { nodeId: 'daily', nodeType: 'user', systemRole: 'daily-notes' },
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'Daily Notes' }] },
              {
                type: 'bulletList',
                content: [{
                  type: 'listItem',
                  attrs: {
                    nodeId: 'today',
                    nodeType: 'user',
                    systemRole: 'daily-note',
                    dailyDate: '2026-08-30',
                  },
                  content: [
                    { type: 'paragraph', content: [{ type: 'text', text: 'Today' }] },
                    {
                      type: 'bulletList',
                      content: [{
                        type: 'listItem',
                        attrs: { nodeId: 'journal', nodeType: 'user' },
                        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Journal' }] }],
                      }],
                    },
                  ],
                }],
              },
            ],
          },
        ],
      }],
    })
    render(<OutlinerChrome editor={editor} trash={[]} onTrashChange={onTrashChange} />)
    expect(getOutlinerUiState(editor).zoomId).toBeNull()
    const menuButton = editor.view.dom.querySelector('[data-node-id="today"] .bullet-menu') as HTMLButtonElement

    await user.click(menuButton)
    await user.click(screen.getByRole('menuitem', { name: 'Move to Trash' }))

    expect(collectBullets(editor.state.doc).map((entry) => entry.id)).toEqual(['inbox', 'daily'])
    expect(onTrashChange).toHaveBeenCalledWith([
      expect.objectContaining({
        originalParentId: 'daily',
        node: expect.objectContaining({
          attrs: expect.objectContaining({
            nodeId: 'today',
            systemRole: 'daily-note',
            dailyDate: '2026-08-30',
          }),
        }),
      }),
    ])
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
