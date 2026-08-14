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

vi.mock('@tauri-apps/api/path', () => ({
  homeDir: async () => '/home/test',
  join: async (...parts: string[]) => parts.join('/'),
}))

vi.mock('@tauri-apps/plugin-fs', () => ({
  exists: async () => false,
  mkdir: async () => undefined,
  readTextFile: async () => '',
  writeTextFile: async () => undefined,
}))

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
  return view
}

describe('App view switching', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('keeps the same editor instance when toggling Settings', async () => {
    const user = userEvent.setup()
    const { container } = await renderApp()
    const editorBefore = container.querySelector('.ProseMirror')

    await user.click(screen.getByRole('button', { name: 'Settings' }))
    await screen.findByRole('heading', { name: 'Settings' })
    await user.click(screen.getByRole('button', { name: 'Outline' }))

    // Same DOM node means the editor was never torn down, so the document and
    // undo stack survived the round trip.
    expect(container.querySelector('.ProseMirror')).toBe(editorBefore)
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

  it('preserves edits made before opening Settings', async () => {
    const user = userEvent.setup()
    const { container } = await renderApp()

    const editor = container.querySelector('.ProseMirror') as HTMLElement
    await user.click(editor)
    await user.keyboard('Notes I do not want to lose')
    expect(editor.textContent).toContain('Notes I do not want to lose')

    await user.click(screen.getByRole('button', { name: 'Settings' }))
    await screen.findByRole('heading', { name: 'Settings' })
    await user.click(screen.getByRole('button', { name: 'Outline' }))

    expect(container.querySelector('.ProseMirror')?.textContent).toContain(
      'Notes I do not want to lose',
    )
  })
})
