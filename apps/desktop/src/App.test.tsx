// The outliner editor holds the live document. It remains mounted across
// secondary views so transient selection and command state are preserved;
// durable undo/redo is independently represented by compensating events.
//
// The Tauri plugins are mocked because there is no Tauri runtime under jsdom;
// everything above them (persistence, settings store, App) is the real code.

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import { formatDailyDate, localCalendarDate } from './editor/dailyNotes'
import { replayOutlineEvents, type EventEnvelope } from '@forage/domain'
import { EMPTY_DOC } from './editor/emptyDoc'
import { insertExtensionSkillResult } from './agent/insertIntoEditor'
import type { Editor } from '@tiptap/core'
import { currentBulletId, findBullet, trashBullet, restoreBullet } from './editor/outlineModel'
import { getOutlinerUiState, setZoom } from './editor/outlinerUi'
import { requestInternalNavigation } from './editor/internalLinks'
import * as pageBridge from './components/Outliner/pagePeek'
import { requestLinkPeek } from './editor/externalLinks'
import { initialProgress, useOnboardingStore } from './onboarding/progress'

const nativeMocks = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: nativeMocks.invoke, isTauri: () => false }))

vi.mock('./editor/readerDocument', async importOriginal => ({
  ...(await importOriginal<typeof import('./editor/readerDocument')>()),
  fetchReaderDocument: vi.fn(async (href: string) => ({ href, host: new URL(href).hostname, title: 'Test article', blocks: [], minutes: 1, fetchedAt: 0 })),
}))

vi.mock('@tauri-apps/api/path', () => ({
  homeDir: async () => '/home/test',
  appDataDir: async () => '/home/test/appdata',
  join: async (...parts: string[]) => parts.join('/'),
}))

vi.mock('@tauri-apps/plugin-store', () => ({
  load: async () => ({
    get: async () => undefined,
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
  await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)) })
  await waitFor(() => expect(view.container.querySelector('.ProseMirror')).not.toBeNull())
  return view
}

describe('App view switching', () => {
  beforeEach(() => {
    // These regression cases exercise an existing installation's workspace.
    useOnboardingStore.setState({ progress: initialProgress(false, 'outline-1'), loaded: true, busy: false, error: null })
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

  it('dispatches workspace keys once, protects final close, and respects input ownership', async () => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Linux')
    const { container } = await renderApp()
    const panes = () => container.querySelectorAll('.workspace-outline-pane')
    const editor = (container.querySelector('.tiptap') as HTMLElement & { editor: Editor }).editor
    act(() => editor.commands.focus())
    const before = editor.getJSON()
    fireEvent.keyDown(editor.view.dom, { key: '|', code: 'Backslash', ctrlKey: true, shiftKey: true })
    await waitFor(() => expect(panes()).toHaveLength(2))
    expect(editor.getJSON()).toEqual(before)
    fireEvent.keyDown(window, { key: 'w', code: 'KeyW', ctrlKey: true })
    await waitFor(() => expect(panes()).toHaveLength(1))
    const finalClose = new KeyboardEvent('keydown', { key: 'w', code: 'KeyW', ctrlKey: true, cancelable: true })
    act(() => window.dispatchEvent(finalClose))
    expect(finalClose.defaultPrevented).toBe(true)
    expect(panes()).toHaveLength(1)
    fireEvent.keyDown(window, { key: '|', code: 'Backslash', ctrlKey: true, shiftKey: true, isComposing: true })
    expect(panes()).toHaveLength(1)
    const input = document.body.appendChild(document.createElement('input'))
    input.focus()
    fireEvent.keyDown(input, { key: '|', code: 'Backslash', ctrlKey: true, shiftKey: true })
    expect(panes()).toHaveLength(1)
    input.remove()
    act(() => editor.commands.focus())
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Pane actions' }))
    fireEvent.keyDown(window, { key: '|', code: 'Backslash', ctrlKey: true, shiftKey: true })
    expect(panes()).toHaveLength(1)
    await user.click(screen.getByRole('menuitem', { name: /^Split right/ }))
    await waitFor(() => expect(panes()).toHaveLength(2))
    vi.restoreAllMocks()
  })

  it('routes native Page commands once and keeps both sidebar rails independent', async () => {
    const { container } = await renderApp()
    const editor = (container.querySelector('.tiptap') as HTMLElement & { editor: Editor }).editor
    act(() => requestLinkPeek('https://example.test', currentBulletId(editor) ?? undefined, 'primary'))
    await waitFor(() => expect(container.querySelectorAll('.workspace-web-pane')).toHaveLength(1))
    const owned = vi.spyOn(pageBridge, 'pageResourceOwnedBy').mockImplementation((resourceId, paneId) => resourceId === `test-${paneId}`)
    let lastSource = ''
    const native = (command: string) => {
      lastSource = Array.from(container.querySelectorAll<HTMLElement>('.workspace-web-pane')).slice(-1)[0]?.dataset.paneId ?? lastSource
      act(() => window.dispatchEvent(new CustomEvent('forage-pane-command', { detail: { command, nativePage: true, sourcePaneId: lastSource, resourceId: `test-${lastSource}` } })))
    }
    native('split')
    await waitFor(() => expect(container.querySelectorAll('.workspace-web-pane')).toHaveLength(2))
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }))
    await user.click(screen.getByRole('button', { name: 'Collapse activity sidebar' }))
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Expand activity sidebar' })).toBeTruthy()
    native('close')
    await waitFor(() => expect(container.querySelectorAll('.workspace-web-pane')).toHaveLength(1))
    native('close')
    await waitFor(() => expect(container.querySelectorAll('.workspace-web-pane')).toHaveLength(0))
    native('split') // A delayed event from a closed native page cannot split an outline.
    expect(container.querySelectorAll('.workspace-outline-pane')).toHaveLength(1)
    owned.mockRestore()
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

  it('opens repeated internal targets immediately right, scopes plain navigation, and rejects broken links', async () => {
    const { container } = await renderApp()
    const dom = container.querySelector('.ProseMirror') as HTMLElement & { editor: Editor }
    const id = currentBulletId(dom.editor)!
    const source = dom.dataset.paneId!
    nativeMocks.invoke.mockClear()
    act(() => requestInternalNavigation(dom.editor, id, true))
    await waitFor(() => expect(container.querySelectorAll('.ProseMirror')).toHaveLength(2))
    const right = container.querySelectorAll<HTMLElement & { editor: Editor }>('.ProseMirror')[1]
    act(() => requestInternalNavigation(dom.editor, id, true))
    await waitFor(() => expect(container.querySelectorAll('.ProseMirror')).toHaveLength(3))
    expect(container.querySelectorAll<HTMLElement>('[data-pane-id].workspace-outline-pane')[0].dataset.paneId).toBe(source)
    expect(container.querySelectorAll<HTMLElement>('[data-pane-id].workspace-outline-pane')[2].dataset.paneId).toBe(right.dataset.paneId)
    expect(getOutlinerUiState(dom.editor).zoomId).toBeNull()
    act(() => requestInternalNavigation(dom.editor, id))
    expect(getOutlinerUiState(dom.editor).zoomId).toBe(id)
    act(() => requestInternalNavigation(dom.editor, 'missing-node', true))
    expect(container.querySelectorAll('.ProseMirror')).toHaveLength(3)
    expect(screen.getByRole('alert').textContent).toContain('Linked item no longer exists')
    expect(nativeMocks.invoke.mock.calls.filter(([command]) => command === 'event_store_append')).toHaveLength(0)
  })

  it('preserves pane identities, visits and scroll across secondary views, and routes global navigation from a web pane', async () => {
    const user = userEvent.setup()
    const { container } = await renderApp()
    const a = container.querySelector('.ProseMirror') as HTMLElement & { editor: Editor }
    await user.click(screen.getByRole('button', { name: 'Pane actions' }))
    await user.click(screen.getByRole('menuitem', { name: /^Split right/ }))
    await waitFor(() => expect(container.querySelectorAll('.ProseMirror')).toHaveLength(2))
    const b = container.querySelectorAll<HTMLElement & { editor: Editor }>('.ProseMirror')[1]
    const id = currentBulletId(b.editor)!
    act(() => setZoom(b.editor, id))
    const scroller = b.closest('.workspace-pane-scroll') as HTMLElement
    scroller.scrollTop = 165
    fireEvent.scroll(scroller)
    const originalVisits = getOutlinerUiState(b.editor).backStack
    for (const name of ['Settings', 'Tasks', 'Trash']) {
      await user.click(screen.getByRole('button', { name }))
      await user.click(container.querySelector<HTMLButtonElement>('.sidebar-home')!)
      // Home is a navigation command; returning via the secondary Back button
      // is exercised separately below. Mounted adapters retain their identity.
      expect(container.querySelectorAll('.ProseMirror')[0]).toBe(a)
      expect(container.querySelectorAll('.ProseMirror')[1]).toBe(b)
    }
    act(() => setZoom(b.editor, id))
    scroller.scrollTop = 165
    fireEvent.scroll(scroller)
    await user.click(screen.getByRole('button', { name: 'Settings' }))
    await user.click(screen.getByRole('button', { name: 'Back to outline' }))
    expect(getOutlinerUiState(b.editor).zoomId).toBe(id)
    expect(scroller.scrollTop).toBe(165)
    expect(originalVisits).toHaveLength(1)
    act(() => requestLinkPeek('https://example.test', id, b.dataset.paneId))
    expect(container.querySelector('.workspace-web-pane')).not.toBeNull()
    expect(container.querySelector('.activity-sidebar')).not.toBeNull()
    await user.click(screen.getByRole('button', { name: 'Inbox' }))
    expect(findBullet(b.editor.state.doc, getOutlinerUiState(b.editor).zoomId!)?.systemRole).toBe('inbox')
    expect(getOutlinerUiState(a.editor).zoomId).toBeNull()
  })

  it('shows a deleted pane target and resolves its restoration without replacing its view', async () => {
    const { container } = await renderApp()
    const a = container.querySelector('.ProseMirror') as HTMLElement & { editor: Editor }
    const target = currentBulletId(a.editor)!
    act(() => requestInternalNavigation(a.editor, target, true))
    await waitFor(() => expect(container.querySelectorAll('.ProseMirror')).toHaveLength(2))
    const b = container.querySelectorAll<HTMLElement & { editor: Editor }>('.ProseMirror')[1]
    let entry!: NonNullable<ReturnType<typeof trashBullet>>
    act(() => { entry = trashBullet(a.editor, target)! })
    expect(within(b.closest('.workspace-outline-pane') as HTMLElement).getByRole('status').textContent).toContain('unavailable')
    expect(getOutlinerUiState(b.editor).zoomId).toBe(target)
    act(() => { restoreBullet(a.editor, entry) })
    expect(container.querySelectorAll('.ProseMirror')[1]).toBe(b)
    expect(container.querySelector('.pane-unavailable')).toBeNull()
    expect(getOutlinerUiState(b.editor).zoomId).toBe(target)
  })

  it('routes a node menu and global Search once with two mounted views', async () => {
    const user = userEvent.setup()
    const { container } = await renderApp()
    await user.click(screen.getByRole('button', { name: 'Pane actions' }))
    await user.click(screen.getByRole('menuitem', { name: /^Split right/ }))
    await waitFor(() => expect(container.querySelectorAll('.ProseMirror')).toHaveLength(2))
    const panes = container.querySelectorAll<HTMLElement>('.workspace-outline-pane')
    const menus = within(panes[0]).getAllByRole('button', { name: 'Actions for bullet' })
    await user.click(menus[menus.length - 1])
    expect(screen.getAllByRole('menu')).toHaveLength(1)
    await user.click(screen.getByRole('menuitem', { name: 'Open in right pane' }))
    await waitFor(() => expect(container.querySelectorAll('.ProseMirror')).toHaveLength(3))
    fireEvent.keyDown(window, { key: 'k', metaKey: true })
    expect(screen.getAllByRole('dialog', { name: 'Search outline' })).toHaveLength(1)
  })

  it('scopes slash completion to the current pane and leaves the other invocation unchanged', async () => {
    const user = userEvent.setup()
    const { container } = await renderApp()
    const a = container.querySelector('.ProseMirror') as HTMLElement & { editor: Editor }
    await user.click(a)
    const originalId = currentBulletId(a.editor)!
    await user.keyboard('/res')
    expect(container.querySelector('.slash-menu')?.textContent).toContain('/research')
    act(() => requestLinkPeek('https://example.test', originalId, a.dataset.paneId))
    expect(container.querySelector('.slash-menu')).toBeNull()
    act(() => a.editor.view.focus())
    act(() => {
      a.editor.view.dispatch(a.editor.state.tr.insert(a.editor.state.doc.content.size - 1,
        a.editor.schema.nodes.listItem.create({ nodeId: 'other-invocation' }, a.editor.schema.nodes.paragraph.create())))
      requestInternalNavigation(a.editor, 'other-invocation', true)
    })
    await waitFor(() => expect(container.querySelectorAll('.ProseMirror')).toHaveLength(2))
    const b = container.querySelectorAll<HTMLElement & { editor: Editor }>('.ProseMirror')[1]
    await user.click(b)
    await user.keyboard('/todo{Enter}')
    expect(findBullet(b.editor.state.doc, 'other-invocation')!.bulletKind).toBe('todo')
    expect(findBullet(a.editor.state.doc, originalId)!.text).toBe('/res')
    expect(a.editor.state.doc.eq(b.editor.state.doc)).toBe(true)
    expect(container.querySelectorAll('.slash-menu')).toHaveLength(0)
  })

  it('closes an inactive pane without changing focus and protects the final outline', async () => {
    const user = userEvent.setup()
    const { container } = await renderApp()
    expect(screen.queryByRole('button', { name: 'Close pane' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Pane actions' }))
    await user.click(screen.getByRole('menuitem', { name: /^Split right/ }))
    await waitFor(() => expect(container.querySelectorAll('.ProseMirror')).toHaveLength(2))
    const panes = container.querySelectorAll<HTMLElement>('.workspace-outline-pane')
    const remaining = panes[1].querySelector('.ProseMirror')!
    expect(document.activeElement).toBe(remaining)
    await user.click(within(panes[0]).getByRole('button', { name: 'Close pane' }))
    expect(container.querySelectorAll('.ProseMirror')).toHaveLength(1)
    expect(document.activeElement).toBe(remaining)
    expect(screen.queryByRole('button', { name: 'Close pane' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Pane actions' }))
    expect((screen.getByRole('menuitem', { name: /^Close pane/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows local storage in the sidebar status', async () => {
    const { container } = await renderApp()

    expect(screen.queryByRole('status', { name: 'Storage backend: local' })).not.toBeNull()
    expect(container.querySelector('.sidebar-storage-label')?.textContent).toBe('local')
  })

  it('opens the permanent Tasks destination without storing it as a shortcut', async () => {
    const user = userEvent.setup()
    await renderApp()

    expect(screen.getByRole('button', { name: 'Inbox' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Daily Notes' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Tasks' }))
    expect(screen.getByRole('heading', { name: 'Tasks' })).toBeTruthy()
    expect(screen.getByText('No tasks in the outline.')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Back to outline' }))
    expect(screen.queryByRole('heading', { name: 'Tasks' })).toBeNull()
  })

  it('opens today in the outline and changes dates from the picker beside its title', async () => {
    const user = userEvent.setup()
    const { container } = await renderApp()
    const todayLabel = formatDailyDate(localCalendarDate(new Date()), navigator.language)

    expect(container.querySelector('[data-system-role="daily-note"]')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Daily Notes' }))
    const today = container.querySelector('[data-system-role="daily-note"]')
    expect(today).toBeTruthy()
    expect(today?.querySelector(':scope > p')?.textContent).toBe(todayLabel)
    const picker = screen.getByLabelText(`Change daily note date for ${todayLabel}`)
    expect(picker.closest('label')?.previousSibling?.textContent).toBe(todayLabel)

    fireEvent.change(picker, { target: { value: '2000-01-02' } })

    expect(container.querySelector('[data-system-role="daily-note"][data-daily-date="2000-01-02"]')).toBeTruthy()
    expect(container.querySelector('[data-system-role="daily-note"][data-daily-date="2000-01-02"]')?.classList)
      .toContain('zoom-root')

    await user.click(container.querySelector<HTMLButtonElement>('.sidebar-home')!)

    expect(container.querySelector('[data-system-role="daily-note"][data-daily-date="2000-01-02"]')).toBeTruthy()
    expect(screen.queryAllByLabelText(/Change daily note date for/)).toHaveLength(0)

    await user.click(screen.getByRole('button', { name: 'Daily Notes' }))

    expect(screen.getByLabelText(`Change daily note date for ${todayLabel}`)).toBeTruthy()
  })

  it('opens the command menu visibly from a secondary view', async () => {
    const user = userEvent.setup()
    await renderApp()
    await user.click(screen.getByRole('button', { name: 'Tasks' }))

    fireEvent.keyDown(window, { key: 'k', metaKey: true })

    expect(screen.getByRole('dialog', { name: 'Search outline' })).toBeTruthy()
    await user.type(screen.getByLabelText('Search commands and bullets'), 'daily notes')
    await user.keyboard('{Enter}')
    expect(screen.getByLabelText(/Change daily note date for/)).toBeTruthy()
  })

  it('repairs a legacy checkpoint through one durable migration event before mounting the editor', async () => {
    const legacyState = {
      schemaEpoch: 1,
      trash: [],
      shortcuts: [],
      doc: {
        type: 'doc', content: [{ type: 'bulletList', content: [{
          type: 'listItem',
          attrs: { nodeId: 'legacy', nodeType: 'user', collapsed: false, bulletKind: 'bullet', completed: false },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Legacy content' }] }],
        }] }],
      },
    }
    nativeMocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'event_store_storage_mode') return 'local'
      if (command === 'event_store_identity') {
        return { outlineId: 'outline-1', actorId: 'owner-1', deviceId: 'device-1' }
      }
      if (command === 'event_store_latest_checkpoint') {
        return {
          id: 'checkpoint-legacy', outlineId: 'outline-1', documentVersion: 1,
          schemaEpoch: 1, localSequence: 5, serverRevision: 0,
          stateJson: JSON.stringify(legacyState), integrityHash: 'a'.repeat(64),
          createdAt: '2026-08-30T12:00:00.000Z',
        }
      }
      if (command === 'event_store_events_after' || command === 'event_store_events_before') return []
      if (command === 'event_store_append') return 6
      return undefined
    })

    const { container } = await renderApp()

    await waitFor(() => expect(nativeMocks.invoke).toHaveBeenCalledWith(
      'event_store_append',
      expect.objectContaining({ event: expect.objectContaining({
        envelope: expect.objectContaining({ origin: 'migration', type: 'document.steps_applied' }),
      }) }),
    ))
    await waitFor(() => expect(nativeMocks.invoke).toHaveBeenCalledWith(
      'event_store_save_checkpoint',
      expect.objectContaining({ checkpoint: expect.objectContaining({
        outlineId: 'outline-1', localSequence: 6, schemaEpoch: 1,
      }) }),
    ))
    expect(container.querySelector('[data-system-role="inbox"]')).toBeTruthy()
    expect(container.querySelector('[data-system-role="daily-notes"]')).toBeTruthy()
    expect(container.textContent).toContain('Legacy content')
  })

  it('persists compatibility normalization before editing a legacy orphan note', async () => {
    const legacyState = {
      schemaEpoch: 1,
      trash: [],
      shortcuts: [],
      doc: {
        type: 'doc', content: [
          { type: 'bulletList', content: [
            {
              type: 'listItem', attrs: { nodeId: 'inbox', systemRole: 'inbox' },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Inbox' }] }],
            },
            {
              type: 'listItem', attrs: { nodeId: 'daily', systemRole: 'daily-notes' },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Daily Notes' }] }],
            },
          ] },
          { type: 'bulletNote', content: [{ type: 'text', text: 'Legacy detail' }] },
        ],
      },
    }
    nativeMocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'event_store_storage_mode') return 'local'
      if (command === 'event_store_identity') return { outlineId: 'outline-1', actorId: 'owner-1', deviceId: 'device-1' }
      if (command === 'event_store_latest_checkpoint') return {
        id: 'checkpoint-legacy-note', outlineId: 'outline-1', documentVersion: 1,
        schemaEpoch: 1, localSequence: 0, serverRevision: 0,
        stateJson: JSON.stringify(legacyState), integrityHash: 'a'.repeat(64),
        createdAt: '2026-08-30T12:00:00.000Z',
      }
      if (command === 'event_store_events_after' || command === 'event_store_events_before') return []
      if (command === 'event_store_append') return 1
      return undefined
    })

    const { container } = await renderApp()
    const migrationCall = nativeMocks.invoke.mock.calls.find(([command, input]) => (
      command === 'event_store_append'
      && (input as { event: { envelope: EventEnvelope } }).event.envelope.origin === 'migration'
    ))
    expect(migrationCall).toBeTruthy()
    const migration = (migrationCall![1] as { event: { envelope: EventEnvelope } }).event.envelope
    expect(JSON.stringify(replayOutlineEvents(legacyState, [migration]).doc)).toContain('Legacy detail')
    expect(container.textContent).toContain('Legacy detail')
  })

  it('starts empty at the current event barrier instead of replaying the abandoned history', async () => {
    nativeMocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'event_store_storage_mode') return 'local'
      if (command === 'event_store_identity') {
        return { outlineId: 'outline-1', actorId: 'owner-1', deviceId: 'device-1' }
      }
      if (command === 'event_store_latest_checkpoint') return {
        id: 'checkpoint-broken', outlineId: 'outline-1', documentVersion: 1,
        schemaEpoch: 1, localSequence: 5, serverRevision: 0,
        stateJson: '{broken', integrityHash: 'a'.repeat(64),
        createdAt: '2026-08-30T12:00:00.000Z',
      }
      if (command === 'event_store_events_after') return [
        { localSequence: 6 },
        { localSequence: 9 },
      ]
      if (command === 'event_store_events_before') return [{ localSequence: 9 }]
      return undefined
    })
    const user = userEvent.setup()

    render(<App />)
    await screen.findByRole('heading', { name: 'Could not open your outline' })
    await user.click(screen.getByRole('button', { name: 'Start with an empty outline' }))

    await waitFor(() => expect(nativeMocks.invoke).toHaveBeenCalledWith(
      'event_store_save_checkpoint',
      expect.objectContaining({ checkpoint: expect.objectContaining({
        outlineId: 'outline-1', localSequence: 9,
      }) }),
    ))
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
          agentOriginVersions: [1], minimumAgentClientVersion: '0.1.0',
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
      if (command === 'event_store_events_after' || command === 'event_store_events_before'
        || command === 'event_store_pending') return []
      if (command === 'server_pull_events') {
        return { events: [], currentRevision: 0, nextAfterRevision: null }
      }
      return undefined
    })

    const { container } = await renderApp()

    expect(screen.queryByRole('status', {
      name: 'Storage backend: server: https://notes.example.com',
    })).not.toBeNull()
    expect(container.querySelector('.sidebar-storage-label')?.textContent).toBe('server')
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

  it('does not fall through to a second history implementation after undo is exhausted', async () => {
    const user = userEvent.setup()
    const { container } = await renderApp()
    const editor = container.querySelector('.ProseMirror') as HTMLElement

    await user.click(editor)
    await user.keyboard('x')
    await user.keyboard('{Control>}z{/Control}')
    await user.keyboard('{Control>}z{/Control}')

    const paragraphTexts = () => [...editor.querySelectorAll(':scope p')].map((node) => node.textContent)
    expect(paragraphTexts()).not.toContain('x')
    const undoEvents = nativeMocks.invoke.mock.calls
      .filter(([command, input]) => command === 'event_store_append'
        && (input as { event: { envelope: { type: string } } }).event.envelope.type === 'document.undo_applied')
    expect(undoEvents).toHaveLength(1)
  })

  it('keeps rapid typing and Enter as separate undo units', async () => {
    const user = userEvent.setup()
    const { container } = await renderApp()
    const editor = container.querySelector('.ProseMirror') as HTMLElement

    await user.click(editor)
    await user.keyboard('a{Enter}b')
    await user.keyboard('{Control>}z{/Control}')

    const paragraphTexts = () => [...editor.querySelectorAll(':scope p')].map((node) => node.textContent)
    expect(paragraphTexts()).toContain('a')
    expect(paragraphTexts()).not.toContain('b')

    await user.keyboard('{Control>}z{/Control}')
    expect(paragraphTexts()).toContain('a')

    await user.keyboard('{Control>}z{/Control}')
    expect(paragraphTexts()).not.toContain('a')
  })

  it('undoes tags an extension added to a bullet', async () => {
    const user = userEvent.setup()
    const { container } = await renderApp()
    const dom = container.querySelector('.ProseMirror') as HTMLElement & { editor: import('@tiptap/core').Editor }
    await user.click(dom)
    await user.keyboard('Ship it')
    let nodeId = ''
    dom.editor.state.doc.descendants((node) => {
      if (node.type.name === 'listItem' && node.firstChild?.textContent === 'Ship it') nodeId = String(node.attrs.nodeId)
    })
    const paragraphTexts = () => [...dom.querySelectorAll(':scope p')].map((node) => node.textContent)

    insertExtensionSkillResult(dom.editor as never, nodeId, 'run-tags', {
      version: 2, nodes: [], sources: [], tags: [{ nodeId, add: ['build', 'later'] }],
    }, [nodeId])
    expect(paragraphTexts()).toContain('Ship it #build #later')

    await user.keyboard('{Control>}z{/Control}')
    expect(paragraphTexts()).toContain('Ship it')
    expect(paragraphTexts()).not.toContain('Ship it #build #later')
  })

  it('routes the Edit menu undo and redo through the durable history', async () => {
    const user = userEvent.setup()
    const { container } = await renderApp()
    const dom = container.querySelector('.ProseMirror') as HTMLElement & { editor: import('@tiptap/core').Editor }
    await user.click(dom)
    await user.keyboard('Ship it')
    let nodeId = ''
    dom.editor.state.doc.descendants((node) => {
      if (node.type.name === 'listItem' && node.firstChild?.textContent === 'Ship it') nodeId = String(node.attrs.nodeId)
    })
    const paragraphTexts = () => [...dom.querySelectorAll(':scope p')].map((node) => node.textContent)
    insertExtensionSkillResult(dom.editor as never, nodeId, 'run-tags', {
      version: 2, nodes: [], sources: [], tags: [{ nodeId, add: ['build'] }],
    }, [nodeId])

    // WebKit's menu-driven undo arrives as beforeinput, never as a keydown.
    const undo = new InputEvent('beforeinput', { inputType: 'historyUndo', bubbles: true, cancelable: true })
    fireEvent(dom, undo)
    expect(undo.defaultPrevented).toBe(true)
    expect(paragraphTexts()).toContain('Ship it')

    fireEvent(dom, new InputEvent('beforeinput', { inputType: 'historyRedo', bubbles: true, cancelable: true }))
    expect(paragraphTexts()).toContain('Ship it #build')
  })

  it('captures immediate undo before hashing and persistence finish', async () => {
    const user = userEvent.setup()
    const { container } = await renderApp()
    const editor = container.querySelector('.ProseMirror') as HTMLElement
    const digest = crypto.subtle.digest.bind(crypto.subtle)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const digestSpy = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...args) => {
      await gate
      return digest(...args)
    })

    await user.click(editor)
    await user.keyboard('x')
    await user.keyboard('{Control>}z{/Control}')
    release()

    await waitFor(() => {
      const types = nativeMocks.invoke.mock.calls
        .filter(([command]) => command === 'event_store_append')
        .map(([, input]) => (input as { event: { envelope: { type: string } } }).event.envelope.type)
      expect(types).toContain('document.undo_applied')
      expect(types.indexOf('document.steps_applied')).toBeLessThan(types.indexOf('document.undo_applied'))
    })
    digestSpy.mockRestore()
  })

  it('keeps fresh edits behind an in-flight persistence retry', async () => {
    const user = userEvent.setup()
    let appendAttempt = 0
    let releaseRetry!: () => void
    let announceRetry!: () => void
    const retryGate = new Promise<void>((resolve) => { releaseRetry = resolve })
    const retryStarted = new Promise<void>((resolve) => { announceRetry = resolve })
    const successful: EventEnvelope[] = []
    nativeMocks.invoke.mockImplementation(async (command: string, input?: unknown) => {
      if (command === 'event_store_identity') {
        return { outlineId: 'outline-1', actorId: 'owner-1', deviceId: 'device-1' }
      }
      if (command === 'event_store_latest_checkpoint') return null
      if (command === 'event_store_storage_mode') return 'local'
      if (command === 'event_store_append') {
        appendAttempt += 1
        if (appendAttempt === 1) throw new Error('disk temporarily unavailable')
        if (appendAttempt === 2) {
          announceRetry()
          await retryGate
        }
        successful.push((input as { event: { envelope: EventEnvelope } }).event.envelope)
        return successful.length
      }
      return undefined
    })
    const { container } = await renderApp()
    const editor = container.querySelector('.ProseMirror') as HTMLElement

    await user.click(editor)
    // A click on the editor's outer container has no caret coordinates in
    // jsdom. Anchor the typing probe to its empty user bullet explicitly.
    const view = (editor as HTMLElement & { editor: Editor }).editor
    const target = currentBulletId(view)!
    act(() => view.commands.setTextSelection(findBullet(view.state.doc, target)!.pos + 2))
    await user.keyboard('a')
    expect(await screen.findByText(/disk temporarily unavailable/)).toBeTruthy()
    await user.keyboard('b')
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    await retryStarted
    await user.click(editor)
    await user.keyboard('c')
    releaseRetry()

    await waitFor(() => expect(successful).toHaveLength(3))
    const textFrom = (value: unknown): string => {
      if (!value || typeof value !== 'object') return ''
      const record = value as Record<string, unknown>
      return (typeof record.text === 'string' ? record.text : '')
        + textFrom(record.slice)
        + (Array.isArray(record.content) ? record.content.map(textFrom).join('') : '')
    }
    const inserted = successful.map((event) => (
      event.type === 'document.steps_applied'
      || event.type === 'document.undo_applied'
      || event.type === 'document.redo_applied'
    ) ? event.payload.steps.map(textFrom).join('') : '')
    expect(inserted).toEqual(['a', 'b', 'c'])
  })

  it('keeps saving after a committed event cannot refresh its recovery checkpoint', async () => {
    const user = userEvent.setup()
    const state = { doc: EMPTY_DOC, trash: [], shortcuts: [], schemaEpoch: 1 }
    const records: Array<Record<string, unknown>> = []
    let sequence = 99
    nativeMocks.invoke.mockImplementation(async (command: string, input?: unknown) => {
      if (command === 'event_store_storage_mode') return 'local'
      if (command === 'event_store_identity') {
        return { outlineId: 'outline-1', actorId: 'owner-1', deviceId: 'device-1' }
      }
      if (command === 'event_store_latest_checkpoint') return {
        id: 'checkpoint-99', outlineId: 'outline-1', documentVersion: 1, schemaEpoch: 1,
        localSequence: 99, serverRevision: 0, stateJson: JSON.stringify(state),
        integrityHash: 'a'.repeat(64), createdAt: '2026-08-30T12:00:00.000Z',
      }
      if (command === 'event_store_events_after') {
        const after = (input as { localSequence: number }).localSequence
        return records.filter((record) => Number(record.localSequence) > after)
      }
      if (command === 'event_store_events_before') {
        const { localSequence, limit } = input as { localSequence: number; limit: number }
        return records
          .filter((record) => Number(record.localSequence) <= localSequence)
          .slice(-limit)
      }
      if (command === 'event_store_append') {
        sequence += 1
        const event = (input as { event: { envelope: EventEnvelope } }).event.envelope
        records.push({
          localSequence: sequence, id: event.id, outlineId: event.outlineId,
          baseRevision: event.baseRevision, serverRevision: null, envelope: event,
          status: 'pending', supersededBy: null, createdAt: event.occurredAt,
        })
        return sequence
      }
      if (command === 'event_store_save_checkpoint') throw new Error('checkpoint disk unavailable')
      return undefined
    })
    const { container } = await renderApp()
    const editor = container.querySelector('.ProseMirror') as HTMLElement

    await user.click(editor)
    await user.keyboard('a')

    expect(await screen.findByText(/checkpoint disk unavailable/)).toBeTruthy()
    expect(screen.queryByText(/Outline not saved/i)).toBeNull()

    await user.keyboard('b')
    await waitFor(() => expect(records).toHaveLength(2))
    expect(new Set(records.map((record) => record.id)).size).toBe(2)
  })

  it('serializes synchronization behind persistence without locking editing during network work', async () => {
    const user = userEvent.setup()
    let syncTick: (() => void) | null = null
    const intervalSpy = vi.spyOn(window, 'setInterval').mockImplementation(((handler: TimerHandler) => {
      if (typeof handler === 'function') syncTick = () => handler()
      return 1
    }) as typeof window.setInterval)
    const { container } = await renderApp()
    nativeMocks.invoke.mockClear()
    const editor = container.querySelector('.ProseMirror') as HTMLElement
    const digest = crypto.subtle.digest.bind(crypto.subtle)
    let releaseDigest!: () => void
    const digestGate = new Promise<void>((resolve) => { releaseDigest = resolve })
    const digestSpy = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...args) => {
      await digestGate
      return digest(...args)
    })

    try {
      await user.click(editor)
      await user.keyboard('x')
      expect(syncTick).not.toBeNull()
      syncTick!()

      expect(editor.getAttribute('contenteditable')).toBe('true')
      expect((container.querySelector('#app') as HTMLElement).inert).not.toBe(true)
      await Promise.resolve()
      expect(nativeMocks.invoke.mock.calls.some(([command]) => command === 'event_store_storage_mode')).toBe(false)

      releaseDigest()
      await waitFor(() => expect(editor.getAttribute('contenteditable')).toBe('true'))
      expect((container.querySelector('#app') as HTMLElement).inert).not.toBe(true)
    } finally {
      releaseDigest()
      digestSpy.mockRestore()
      intervalSpy.mockRestore()
    }
  })

  it('shows the live agent activity sidebar and records local commands', async () => {
    const user = userEvent.setup()
    const { container } = await renderApp()
    expect(screen.getByRole('complementary', { name: 'Agent activity' })).toBeTruthy()

    const editor = container.querySelector('.ProseMirror') as HTMLElement
    await user.click(editor)
    await user.keyboard('/todo{Enter}')

    // An outline command is a single activity row with no steps of its own.
    expect(screen.getAllByText('/todo')).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: 'Open /todo' }))
    expect(screen.getByText('No steps were recorded for this call.')).toBeTruthy()
  })

  it('collapses Activity into an independent rail', async () => {
    const user = userEvent.setup()
    await renderApp()
    const sidebar = screen.getByRole('complementary', { name: 'Agent activity' }) as HTMLElement

    await user.click(screen.getByRole('button', { name: 'Collapse activity sidebar' }))

    expect(sidebar.classList.contains('is-collapsed')).toBe(true)
    expect(sidebar.hidden).toBe(false)
    expect(screen.getByRole('button', { name: 'Expand activity sidebar' })).toBeTruthy()
  })

  it('toggles the outline sidebar with the global shortcut', async () => {
    await renderApp()
    const outline = screen.getByRole('complementary', { name: 'Outline sidebar' }) as HTMLElement
    const activity = screen.getByRole('complementary', { name: 'Agent activity' }) as HTMLElement

    fireEvent.keyDown(window, { key: '\\', code: 'Backslash', ctrlKey: true })

    expect(outline.classList.contains('is-collapsed')).toBe(true)
    expect(activity.hidden).toBe(false)

    fireEvent.keyDown(window, { key: '\\', code: 'Backslash', ctrlKey: true })

    expect(outline.classList.contains('is-collapsed')).toBe(false)
  })

  it('toggles the activity sidebar with the global shortcut without stealing the shortcuts panel', async () => {
    await renderApp()
    const outline = screen.getByRole('complementary', { name: 'Outline sidebar' }) as HTMLElement
    const activity = screen.getByRole('complementary', { name: 'Agent activity' }) as HTMLElement

    fireEvent.keyDown(window, { key: '/', code: 'Slash', ctrlKey: true })

    expect(activity.classList.contains('is-collapsed')).toBe(true)
    expect(outline.classList.contains('is-collapsed')).toBe(false)

    fireEvent.keyDown(window, { key: '/', code: 'Slash', ctrlKey: true })

    expect(activity.hidden).toBe(false)

    fireEvent.keyDown(window, { key: '?', code: 'Slash', ctrlKey: true, shiftKey: true })

    expect(screen.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeTruthy()
    expect(activity.hidden).toBe(false)
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
      if (command === 'event_store_events_after' || command === 'event_store_events_before') return []
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

  it('opens keyboard shortcuts from the sidebar and with the global shortcut', async () => {
    const user = userEvent.setup()
    const { container } = await renderApp()
    const shortcutsNav = screen.getByRole('button', { name: 'Keyboard shortcuts' })
    const settingsNav = screen.getByRole('button', { name: 'Settings' })

    expect(shortcutsNav.nextElementSibling).toBe(settingsNav)
    await user.click(shortcutsNav)

    expect(screen.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeTruthy()
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeTruthy()
    expect(screen.getByLabelText('Keyboard shortcut reference')).toBeTruthy()
    expect(screen.getByText('Move branch up')).toBeTruthy()
    expect(screen.getByText('Move current branch to…')).toBeTruthy()
    expect(shortcutsNav.getAttribute('aria-expanded')).toBe('true')
    expect(container.querySelector('.outline-editor-view')?.hasAttribute('hidden')).toBe(false)

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('heading', { name: 'Keyboard shortcuts' })).toBeNull()

    fireEvent.keyDown(window, { key: '?', ctrlKey: true, shiftKey: true })
    expect(screen.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeTruthy()
    fireEvent.keyDown(window, { key: '?', ctrlKey: true, shiftKey: true })
    expect(screen.queryByRole('heading', { name: 'Keyboard shortcuts' })).toBeNull()
  })

  it('persists Trash and restore as one atomic document/domain event each', async () => {
    const user = userEvent.setup()
    const { container } = await renderApp()
    const editor = container.querySelector('.ProseMirror') as HTMLElement
    await user.click(editor)
    await user.keyboard('Atomic branch')
    await waitFor(() => expect(nativeMocks.invoke).toHaveBeenCalledWith(
      'event_store_append', expect.objectContaining({ event: expect.objectContaining({
        envelope: expect.objectContaining({ type: 'document.steps_applied' }),
      }) }),
    ))
    await new Promise((resolve) => window.setTimeout(resolve, 25))
    nativeMocks.invoke.mockClear()

    const paragraph = [...editor.querySelectorAll('p')]
      .find((node) => node.textContent === 'Atomic branch')!
    await user.click(paragraph.closest('li')!.querySelector<HTMLButtonElement>('.bullet-menu')!)
    await user.click(screen.getByRole('menuitem', { name: 'Move to Trash' }))

    await waitFor(() => expect(nativeMocks.invoke).toHaveBeenCalledWith(
      'event_store_append', expect.objectContaining({ event: expect.objectContaining({
        envelope: expect.objectContaining({
          type: 'trash.entry_added',
          payload: expect.objectContaining({ document: expect.objectContaining({ steps: expect.any(Array) }) }),
        }),
      }) }),
    ))
    expect(nativeMocks.invoke.mock.calls
      .filter(([command]) => command === 'event_store_append')
      .map(([, input]) => (input as { event: { envelope: { type: string } } }).event.envelope.type))
      .toEqual(['trash.entry_added'])
    expect([...editor.querySelectorAll('p')].map((node) => node.textContent)).not.toContain('Atomic branch')

    await user.click(screen.getByRole('button', { name: 'Trash' }))
    nativeMocks.invoke.mockClear()
    await user.click(screen.getByRole('button', { name: 'Restore' }))

    await waitFor(() => expect(nativeMocks.invoke).toHaveBeenCalledWith(
      'event_store_append', expect.objectContaining({ event: expect.objectContaining({
        envelope: expect.objectContaining({
          type: 'trash.entry_restored',
          payload: expect.objectContaining({ document: expect.objectContaining({ steps: expect.any(Array) }) }),
        }),
      }) }),
    ))
    expect(nativeMocks.invoke.mock.calls
      .filter(([command]) => command === 'event_store_append')
      .map(([, input]) => (input as { event: { envelope: { type: string } } }).event.envelope.type))
      .toEqual(['trash.entry_restored'])
    expect([...editor.querySelectorAll('p')].map((node) => node.textContent)).toContain('Atomic branch')
  })

  it('keeps Tab and Shift+Tab restructuring active in the complete app', async () => {
    const user = userEvent.setup()
    const { container } = await renderApp()
    const editor = container.querySelector('.ProseMirror') as HTMLElement

    await user.click(editor)
    await user.keyboard('Parent{Enter}Child{Tab}')
    const rootList = editor.querySelector(':scope > ul')
    const ordinaryRoots = () => Array.from(rootList?.children ?? [])
      .filter((child) => !(child as HTMLElement).dataset.systemRole)
    expect(ordinaryRoots()).toHaveLength(1)
    expect(ordinaryRoots()[0]?.querySelector('ul li')?.textContent).toContain('Child')

    await user.keyboard('{Shift>}{Tab}{/Shift}')
    expect(ordinaryRoots()).toHaveLength(2)
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

  it('confirms dirty settings drafts before keyboard or sidebar navigation closes Settings', async () => {
    const user = userEvent.setup()
    await renderApp()
    await user.click(screen.getByRole('button', { name: 'Settings' }))
    await user.click(screen.getByRole('button', { name: 'Agents' }))
    await user.click(screen.getByRole('button', { name: 'Add agent' }))
    await user.type(screen.getByLabelText('Agent name'), 'Unsaved agent')
    fireEvent.keyDown(window, { key: ',', ctrlKey: true })
    expect(screen.getByRole('alertdialog', { name: 'Discard unsaved changes?' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Keep editing' }))
    await user.click(screen.getByRole('button', { name: 'Home' }))
    expect(screen.getByRole('alertdialog', { name: 'Discard unsaved changes?' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Discard changes' }))
    expect(screen.queryByRole('group', { name: 'Agent editor' })).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Settings' })).toBeNull()
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
