// The outliner editor holds the live document. It remains mounted across
// secondary views so transient selection and command state are preserved;
// durable undo/redo is independently represented by compensating events.
//
// The Tauri plugins are mocked because there is no Tauri runtime under jsdom;
// everything above them (persistence, settings store, App) is the real code.

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'

const nativeMocks = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: nativeMocks.invoke }))

vi.mock('@tauri-apps/api/path', () => ({
  homeDir: async () => '/home/test',
  appDataDir: async () => '/home/test/appdata',
  join: async (...parts: string[]) => parts.join('/'),
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
  // Let the independent outline/settings startup effects settle before callers
  // capture editor identity; either effect may schedule one final render.
  await new Promise((resolve) => window.setTimeout(resolve, 0))
  await waitFor(() => expect(view.container.querySelector('.ProseMirror')).not.toBeNull())
  return view
}

describe('App view switching', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    nativeMocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'event_store_identity') {
        return { outlineId: 'outline-1', actorId: 'owner-1', deviceId: 'device-1' }
      }
      if (command === 'event_store_latest_checkpoint') return null
      if (command === 'event_store_storage_mode') return 'local'
      if (command === 'event_store_append') return 1
      return undefined
    })
  })

  it('durably appends typing as an event instead of scheduling an iCloud snapshot', async () => {
    const user = userEvent.setup()
    const { container } = await renderApp()
    const editor = container.querySelector('.ProseMirror') as HTMLElement

    await user.click(editor)
    await user.keyboard('durable')

    await waitFor(() => expect(nativeMocks.invoke).toHaveBeenCalledWith(
      'event_store_append',
      expect.objectContaining({
        event: expect.objectContaining({
          envelope: expect.objectContaining({ type: 'document.steps_applied' }),
        }),
      }),
    ))
  })

  it('shows local storage in a dedicated backend widget', async () => {
    const { container } = await renderApp()

    expect(screen.queryByRole('status', { name: 'Storage backend: local' })).not.toBeNull()
    expect(container.querySelector('.storage-backend-widget')?.textContent).toBe('local')
  })

  it('shows the configured URL in the backend widget for server storage', async () => {
    const state = {
      schemaEpoch: 1,
      trash: [],
      shortcuts: [],
      doc: {
        type: 'doc',
        content: [{
          type: 'bulletList',
          content: [{
            type: 'listItem',
            attrs: { nodeId: 'server-note', nodeType: 'user', collapsed: false },
            content: [{ type: 'paragraph' }],
          }],
        }],
      },
    }
    nativeMocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'event_store_storage_mode') return 'server'
      if (command === 'event_store_identity') {
        return { outlineId: 'local-outline', actorId: 'owner-1', deviceId: 'device-1' }
      }
      if (command === 'server_connection_info') {
        return { origin: 'https://notes.example.com', instanceId: 'instance-1', outlineId: 'outline-1' }
      }
      if (command === 'server_test_connection') {
        return {
          instanceId: 'instance-1', apiVersions: [1], eventVersions: { 'note.created': [1] },
          documentSchemaVersion: 1, minimumClientVersion: '0.1.0',
        }
      }
      if (command === 'server_checkpoint') {
        return { checkpoint: {
          id: 'server-checkpoint', outlineId: 'outline-1', documentVersion: 1,
          schemaEpoch: 1, revision: 0, integrityHash: 'a'.repeat(64), state,
        } }
      }
      if (command === 'event_store_latest_checkpoint') {
        return {
          id: 'local-checkpoint', outlineId: 'outline-1', documentVersion: 1,
          schemaEpoch: 1, localSequence: 0, serverRevision: 0,
          stateJson: JSON.stringify(state), integrityHash: 'a'.repeat(64),
          createdAt: '2026-08-30T12:00:00.000Z',
        }
      }
      if (command === 'event_store_events_after' || command === 'event_store_pending') return []
      if (command === 'server_pull_events') {
        return { events: [], currentRevision: 0, nextAfterRevision: null }
      }
      return undefined
    })

    const { container } = await renderApp()

    expect(screen.queryByRole('status', {
      name: 'Storage backend: server: https://notes.example.com',
    })).not.toBeNull()
    expect(container.querySelector('.storage-backend-widget')?.textContent)
      .toBe('server: https://notes.example.com')
  })

  it('persists undo as a compensating event targeting the durable typing event', async () => {
    const user = userEvent.setup()
    const { container } = await renderApp()
    const editor = container.querySelector('.ProseMirror') as HTMLElement
    await user.click(editor)
    await user.keyboard('undo me')
    await waitFor(() => expect(nativeMocks.invoke).toHaveBeenCalledWith(
      'event_store_append', expect.objectContaining({ event: expect.objectContaining({
        envelope: expect.objectContaining({ type: 'document.steps_applied' }),
      }) }),
    ))
    await user.keyboard('{Control>}z{/Control}')
    await waitFor(() => expect(nativeMocks.invoke).toHaveBeenCalledWith(
      'event_store_append', expect.objectContaining({ event: expect.objectContaining({
        envelope: expect.objectContaining({
          type: 'document.undo_applied',
          payload: expect.objectContaining({ targetEventIds: expect.any(Array) }),
        }),
      }) }),
    ))
  })

  it('shows the live agent activity sidebar and records local commands', async () => {
    const user = userEvent.setup()
    const { container } = await renderApp()
    expect(screen.getByRole('complementary', { name: 'Agent activity' })).toBeTruthy()

    const editor = container.querySelector('.ProseMirror') as HTMLElement
    await user.click(editor)
    await user.keyboard('/todo{Enter}')

    expect(screen.getAllByText('/todo')).toHaveLength(2)
    expect(screen.getByRole('list', { name: 'Execution timeline for /todo' })).toBeTruthy()
  })

  it('fully hides the activity sidebar from the header toggle', async () => {
    const user = userEvent.setup()
    await renderApp()
    const sidebar = screen.getByRole('complementary', { name: 'Agent activity' }) as HTMLElement

    await user.click(screen.getByRole('button', { name: 'Collapse activity sidebar' }))

    expect(sidebar.hidden).toBe(true)
    expect(screen.getByRole('button', { name: 'Expand activity sidebar' })).toBeTruthy()
  })

  it('shows a recoverable error instead of silently replacing an unreadable outline', async () => {
    const user = userEvent.setup()
    let checkpointAttempts = 0
    nativeMocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'event_store_identity') {
        return { outlineId: 'outline-1', actorId: 'owner-1', deviceId: 'device-1' }
      }
      if (command === 'event_store_latest_checkpoint') {
        checkpointAttempts += 1
        if (checkpointAttempts === 1) throw new Error('permission denied')
        return {
          id: 'checkpoint-1', outlineId: 'outline-1', documentVersion: 1, schemaEpoch: 1,
          localSequence: 0, serverRevision: 0, integrityHash: 'a'.repeat(64),
          createdAt: '2026-08-30T12:00:00.000Z',
          stateJson: JSON.stringify({
            trash: [], shortcuts: [], schemaEpoch: 1,
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
          }),
        }
      }
      if (command === 'event_store_events_after') return []
      return undefined
    })
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
    await waitFor(() => expect(container.querySelector('li.skill-context-invocation')).not.toBeNull())

    await user.click(screen.getByRole('button', { name: 'Settings' }))
    expect(container.querySelector('li.skill-context-invocation')).toBeNull()
  })

  it('lets internal-link autocomplete finish before running a skill', async () => {
    const user = userEvent.setup()
    const { container } = await renderApp()
    const editor = container.querySelector('.ProseMirror') as HTMLElement

    await user.click(editor)
    await user.keyboard('Reference topic{Enter}/ask [[[[Reference')
    expect(await screen.findByRole('list', { name: 'Internal link suggestions' })).not.toBeNull()

    await user.keyboard('{Enter}')

    const link = container.querySelector<HTMLAnchorElement>('a[data-internal-node-id]')
    expect(link?.textContent).toBe('Reference topic')
    expect(editor.textContent).toContain('/ask Reference topic')
    expect(container.querySelector('li[data-node-type="ai"]')).toBeNull()
  })

  it('opens tag-filtered search when a hashtag is clicked', async () => {
    const user = userEvent.setup()
    const { container } = await renderApp()
    const editor = container.querySelector('.ProseMirror') as HTMLElement

    await user.click(editor)
    await user.keyboard('Tagged note #research')
    const tag = container.querySelector('.outline-tag') as HTMLElement
    await user.click(tag)

    const search = await screen.findByRole('combobox', { name: 'Search commands and bullets' }) as HTMLInputElement
    expect(search.value).toBe('#research')
    expect(screen.getByRole('button', { name: 'Open Tagged note #research' })).toBeTruthy()
  })

  it('shows tools and can add an approved custom HTTP tool', async () => {
    const user = userEvent.setup()
    await renderApp()

    await user.click(screen.getByRole('button', { name: 'Settings' }))
    await user.click(screen.getByRole('button', { name: 'Agents' }))
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
    await user.click(screen.getByRole('button', { name: 'Agents' }))
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
    expect(screen.queryByLabelText('Context strategy preset')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Save skill' }))
    expect(await screen.findByText('/polish')).not.toBeNull()
    expect(screen.getAllByText('Editor').length).toBeGreaterThan(0)

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
