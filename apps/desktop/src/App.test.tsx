// The outliner editor holds the live document. It remains mounted across
// secondary views so transient selection and command state are preserved;
// durable undo/redo is independently represented by compensating events.
//
// The Tauri plugins are mocked because there is no Tauri runtime under jsdom;
// everything above them (persistence, settings store, App) is the real code.

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import { formatDailyDate, localCalendarDate } from './editor/dailyNotes'
import { replayOutlineEvents, type EventEnvelope } from '@forage/domain'
import { EMPTY_DOC } from './editor/emptyDoc'

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
      if (command === 'event_store_events_after') return []
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
      if (command === 'event_store_events_after') return []
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

  it('serializes periodic synchronization behind pending persistence', async () => {
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

      expect(editor.getAttribute('contenteditable')).toBe('false')
      expect((container.querySelector('#app') as HTMLElement).inert).toBe(true)
      await Promise.resolve()
      expect(nativeMocks.invoke.mock.calls.some(([command]) => command === 'event_store_storage_mode')).toBe(false)

      releaseDigest()
      await waitFor(() => expect(nativeMocks.invoke.mock.calls
        .some(([command]) => command === 'event_store_storage_mode')).toBe(true))
      const commands = nativeMocks.invoke.mock.calls.map(([command]) => command)
      expect(commands.indexOf('event_store_append')).toBeLessThan(commands.indexOf('event_store_storage_mode'))
      await waitFor(() => expect(editor.getAttribute('contenteditable')).toBe('true'))
      expect((container.querySelector('#app') as HTMLElement).inert).toBe(false)
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
