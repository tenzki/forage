// The outliner editor holds the live document and the undo history. If it is
// unmounted when the user opens Settings, coming back remounts it with the
// snapshot loaded at startup — silently discarding the session's edits, which
// the debounced saver then writes over tree.json.
//
// The Tauri plugins are mocked because there is no Tauri runtime under jsdom;
// everything above them (persistence, settings store, App) is the real code.

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'

const fsMocks = vi.hoisted(() => ({
  exists: vi.fn(async () => false),
  mkdir: vi.fn(async () => undefined),
  readTextFile: vi.fn(async () => ''),
  writeTextFile: vi.fn(async () => undefined),
}))

vi.mock('@tauri-apps/api/path', () => ({
  homeDir: async () => '/home/test',
  join: async (...parts: string[]) => parts.join('/'),
}))

vi.mock('@tauri-apps/plugin-fs', () => fsMocks)

vi.mock('@tauri-apps/plugin-store', () => ({
  load: async () => ({
    get: async () => '',
    set: async () => undefined,
    delete: async () => true,
    save: async () => undefined,
  }),
}))

async function renderApp() {
  const view = render(<App />)
  await waitFor(() => expect(view.container.querySelector('.ProseMirror')).not.toBeNull())
  // Let the independent outline/settings startup effects settle before callers
  // capture editor identity; either effect may schedule one final render.
  await new Promise((resolve) => window.setTimeout(resolve, 0))
  await waitFor(() => expect(view.container.querySelector('.ProseMirror')).not.toBeNull())
  return view
}

describe('App view switching', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fsMocks.exists.mockResolvedValue(false)
    fsMocks.readTextFile.mockResolvedValue('')
    fsMocks.writeTextFile.mockResolvedValue(undefined)
  })

  it('shows a recoverable error instead of silently replacing an unreadable outline', async () => {
    const user = userEvent.setup()
    fsMocks.exists.mockResolvedValue(true)
    fsMocks.readTextFile
      .mockRejectedValueOnce(new Error('permission denied'))
      .mockResolvedValueOnce(JSON.stringify({
        version: 2,
        trash: [],
        doc: {
          type: 'doc',
          content: [{
            type: 'bulletList',
            content: [{
              type: 'listItem',
              attrs: { nodeId: 'recovered', nodeType: 'user', collapsed: false },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Recovered' }] }],
            }],
          }],
        },
      }))
    const view = render(<App />)

    expect(await screen.findByRole('heading', { name: 'Could not open your outline' })).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Start with an empty outline' })).not.toBeNull()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(view.container.querySelector('.ProseMirror')?.textContent).toContain('Recovered'))
  })

  it('keeps the same editor instance when toggling Settings', async () => {
    const user = userEvent.setup()
    const { container } = await renderApp()
    const editorBefore = container.querySelector('.ProseMirror')

    await user.click(screen.getByRole('button', { name: 'Settings' }))
    await screen.findByRole('heading', { name: 'Settings' })
    await user.click(screen.getByRole('button', { name: /Back/ }))

    // Same DOM node means the editor was never torn down, so the document and
    // undo stack survived the round trip.
    expect(container.querySelector('.ProseMirror')).toBe(editorBefore)
  })

  it('opens Settings and Trash in the main panel while keeping the sidebar', async () => {
    const user = userEvent.setup()
    const { container } = await renderApp()
    const sidebar = screen.getByRole('complementary', { name: 'Outline sidebar' })

    const settingsNav = screen.getByRole('button', { name: 'Settings' })
    await user.click(settingsNav)
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeTruthy()
    expect(settingsNav.getAttribute('aria-current')).toBe('page')
    expect(screen.getByRole('button', { name: 'Back to outline' }).closest('.secondary-view-header')).toBeTruthy()
    expect(document.body.contains(sidebar)).toBe(true)

    await user.click(screen.getByRole('button', { name: 'Back to outline' }))
    const trashNav = screen.getByRole('button', { name: 'Trash' })
    await user.click(trashNav)
    expect(await screen.findByRole('heading', { name: 'Trash' })).toBeTruthy()
    expect(trashNav.getAttribute('aria-current')).toBe('page')
    expect(screen.queryByRole('dialog', { name: 'Trash' })).toBeNull()
    expect(document.body.contains(sidebar)).toBe(true)
    expect(container.querySelector('.outline-editor-view')?.hasAttribute('hidden')).toBe(true)
  })

  it('keeps Tab and Shift+Tab restructuring active in the complete app', async () => {
    const user = userEvent.setup()
    const { container } = await renderApp()
    const editor = container.querySelector('.ProseMirror') as HTMLElement

    await user.click(editor)
    await user.keyboard('Parent{Enter}Child{Tab}')
    const rootList = editor.querySelector(':scope > ul')
    expect(rootList?.children).toHaveLength(1)
    expect(rootList?.querySelector('ul li')?.textContent).toContain('Child')

    await user.keyboard('{Shift>}{Tab}{/Shift}')
    expect(rootList?.children).toHaveLength(2)
  })

  it('runs a todo slash command after Tab completion', async () => {
    const user = userEvent.setup()
    const { container } = await renderApp()
    const editor = container.querySelector('.ProseMirror') as HTMLElement

    await user.click(editor)
    await user.keyboard('/todo')
    expect(container.querySelector('.slash-menu')?.textContent).toContain('/todo')
    await user.keyboard('{Tab}Buy milk{Enter}')

    const todo = container.querySelector('li[data-bullet-kind="todo"]')
    expect(todo?.textContent).toContain('Buy milk')
    expect(todo?.querySelector('.todo-checkbox')).toBeTruthy()
  })

  it('runs a local outline command directly with Enter', async () => {
    const user = userEvent.setup()
    const { container } = await renderApp()
    const editor = container.querySelector('.ProseMirror') as HTMLElement

    await user.click(editor)
    await user.keyboard('/done{Enter}')

    const todo = container.querySelector('li[data-bullet-kind="todo"]')
    expect(todo?.getAttribute('data-completed')).toBe('true')
  })

  it('hides slash suggestions after Tab completes a command', async () => {
    const user = userEvent.setup()
    const { container } = await renderApp()
    const editor = container.querySelector('.ProseMirror') as HTMLElement

    await user.click(editor)
    await user.keyboard('/res')
    expect(container.querySelector('.slash-menu')).not.toBeNull()

    await user.keyboard('{Tab}')
    expect(container.querySelector('.slash-menu')).toBeNull()
    expect(editor.textContent).toContain('/research ')

    await user.keyboard('Workflowy alternatives')
    expect(container.querySelector('.slash-menu')).toBeNull()
    await waitFor(() => expect(container.querySelector('li.skill-context-included')).not.toBeNull())

    await user.click(screen.getByRole('button', { name: 'Settings' }))
    expect(container.querySelector('li.skill-context-included')).toBeNull()
  })

  it('opens tag-filtered search when a hashtag is clicked', async () => {
    const user = userEvent.setup()
    const { container } = await renderApp()
    const editor = container.querySelector('.ProseMirror') as HTMLElement

    await user.click(editor)
    await user.keyboard('Tagged note #research')
    const tag = container.querySelector('.outline-tag') as HTMLElement
    await user.click(tag)

    const search = await screen.findByRole('combobox', { name: 'Search bullets' }) as HTMLInputElement
    expect(search.value).toBe('#research')
    expect(screen.getByDisplayValue('Tagged note #research')).toBeTruthy()
  })

  it('shows tools and can add an approved custom HTTP tool', async () => {
    const user = userEvent.setup()
    await renderApp()

    await user.click(screen.getByRole('button', { name: 'Settings' }))
    expect(await screen.findByText('Web search')).not.toBeNull()
    expect(screen.getByText('Read webpages')).not.toBeNull()

    await user.click(screen.getByRole('button', { name: /Add custom tool/ }))
    await user.type(screen.getByLabelText('Tool name'), 'github_issues')
    await user.type(
      screen.getByLabelText('Description for Codex'),
      'List public issues for a GitHub repository',
    )
    await user.click(screen.getByRole('button', { name: 'Add tool' }))

    expect(await screen.findByText('github_issues')).not.toBeNull()
    const enabled = screen.getByRole('checkbox', { name: 'Enable github_issues' }) as HTMLInputElement
    expect(enabled.checked).toBe(true)
  })

  it('can configure a custom agent and slash-command skill', async () => {
    const user = userEvent.setup()
    await renderApp()

    await user.click(screen.getByRole('button', { name: 'Settings' }))
    await user.click(screen.getByRole('button', { name: /Add agent/ }))
    await user.type(screen.getByLabelText('Agent name'), 'Editor')
    await user.type(screen.getByLabelText('Agent description'), 'Edits prose')
    await user.type(screen.getByLabelText('Agent instructions'), 'Improve writing while preserving meaning.')
    await user.click(screen.getByRole('button', { name: 'Save agent' }))
    expect(await screen.findByText('Editor')).not.toBeNull()

    await user.click(screen.getByRole('button', { name: /Add skill/ }))
    await user.type(screen.getByLabelText('Slash command'), 'polish')
    await user.type(screen.getByLabelText('Skill description'), 'Polish this branch')
    await user.selectOptions(screen.getByLabelText('Skill agent'), 'Editor')
    await user.type(screen.getByLabelText('Skill instructions'), 'Rewrite the requested text clearly.')
    await user.selectOptions(screen.getByLabelText('Context strategy preset'), 'parent-branch')
    expect((screen.getByLabelText('Context root') as HTMLSelectElement).value).toBe('parent')
    await user.click(screen.getByRole('button', { name: 'Save skill' }))
    expect(await screen.findByText('/polish')).not.toBeNull()
    expect(screen.getByText(/Editor · Parent branch/)).not.toBeNull()

    await user.click(screen.getByRole('button', { name: 'Back to outline' }))
    const editor = document.querySelector('.ProseMirror') as HTMLElement
    await user.click(editor)
    await user.keyboard('/pol')
    expect(document.querySelector('.slash-menu')?.textContent).toContain('/polish')
  })

  it('preserves edits made before opening Settings', async () => {
    const user = userEvent.setup()
    const { container } = await renderApp()

    const editor = container.querySelector('.ProseMirror') as HTMLElement
    await user.click(editor)
    await user.keyboard('Notes I do not want to lose')
    expect(editor.textContent).toContain('Notes I do not want to lose')

    await user.click(screen.getByRole('button', { name: 'Settings' }))
    await screen.findByRole('heading', { name: 'Settings' })
    await user.click(screen.getByRole('button', { name: /Back/ }))

    expect(container.querySelector('.ProseMirror')?.textContent).toContain(
      'Notes I do not want to lose',
    )
  })
})
