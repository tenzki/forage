import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Editor } from '@tiptap/core'
import App from '../App'
import { useSettingsStore } from '../store/settingsStore'
import { useExtensionStore } from '../store/extensionStore'
import { useMcpStore } from '../store/mcpStore'
import { collectBullets, findBullet } from '../editor/outlineModel'
import { useOnboardingStore } from './progress'
import { OutlineSession } from '../application/OutlineSession'
import { skillExecution } from '../agent/skillExecution'
import type { LocalAgentRun } from '../persistence/eventStore'

const fixture = vi.hoisted(() => ({ files: new Map<string, Map<string, unknown>>(), invoke: vi.fn(), failAppend: false }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: fixture.invoke, isTauri: () => false }))
vi.mock('@tauri-apps/api/path', () => ({ homeDir: async () => '/fixture', appDataDir: async () => '/fixture/data', resolveResource: async (path: string) => `/fixture/resources/${path}`, join: async (...parts: string[]) => parts.join('/') }))
vi.mock('@tauri-apps/plugin-store', () => ({ load: async (name: string) => {
  const values = () => { if (!fixture.files.has(name)) fixture.files.set(name, new Map()); return fixture.files.get(name)! }
  return { get: async (key: string) => values().get(key), set: async (key: string, value: unknown) => { values().set(key, value) }, delete: async (key: string) => values().delete(key), save: async () => undefined }
} }))

const scan = vi.fn(async () => undefined)
const install = vi.fn(async () => undefined)
function navigation() { return within(screen.getByRole('contentinfo', { name: 'Setup navigation' })) }
async function click(label: string, advances = true) {
  await waitFor(() => expect((navigation().getByRole('button', { name: label }) as HTMLButtonElement).disabled).toBe(false), { timeout: 8000 })
  const previous = useOnboardingStore.getState().progress!
  await act(async () => { fireEvent.click(navigation().getByRole('button', { name: label })); await new Promise(resolve => setTimeout(resolve, 15)) })
  if (advances) await waitFor(() => {
    const state = useOnboardingStore.getState()
    expect(state.progress?.step !== previous.step || state.progress?.status !== previous.status).toBe(true)
    expect(state.busy).toBe(false)
  }, { timeout: 8000 })
}

async function mount() {
  const view = render(<App />)
  await screen.findByRole('heading', { name: 'Start with a note' }, { timeout: 8000 })
  await waitFor(() => expect(view.container.querySelector('.tiptap')).not.toBeNull())
  await waitFor(() => expect((navigation().getByRole('button', { name: 'Skip setup' }) as HTMLButtonElement).disabled).toBe(false))
  const editor = (view.container.querySelector('.tiptap') as HTMLElement & { editor: Editor }).editor
  return { ...view, editor }
}
function typeNote(editor: Editor) {
  const blank = collectBullets(editor.state.doc).find(bullet => bullet.systemRole === null)!
  act(() => editor.view.dispatch(editor.state.tr.insertText('Plan a useful project', blank.pos + 2)))
  return blank.id
}

beforeEach(() => {
  vi.restoreAllMocks(); fixture.files.clear(); fixture.failAppend = false; scan.mockClear(); install.mockClear()
  useOnboardingStore.setState({ progress: null, loaded: false, busy: false, error: null })
  useSettingsStore.setState({ isLoaded: false, hadPriorSettings: true, error: null, localCredentials: [] })
  useExtensionStore.setState({ isLoaded: true, isLoading: false, busyInstallationId: null, error: null, catalog: { version: 1, revision: 'a'.repeat(64), entries: [] }, configuration: { version: 1, revision: 1, sources: [] }, refresh: async () => undefined, install })
  useMcpStore.setState({ loaded: true, connections: [], busy: false, discovery: null, scanConnections: scan, authorizationProgress: null })
  fixture.invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === 'event_store_identity') return { outlineId: 'outline', actorId: 'owner', deviceId: 'device' }
    if (command === 'event_store_latest_checkpoint') return null
    if (command === 'event_store_storage_mode') return 'local'
    if (command === 'event_store_append') { if (fixture.failAppend) throw new Error('Disk full'); return 1 }
    if (command === 'agent_run_history') return []
    if (command === 'local_credential_load') return 'fixture-key'
    return undefined
  })
})

describe('integrated onboarding', () => {
  it('edits the canonical outline, skips optional setup without side effects, and opens the same editor', async () => {
    const { editor } = await mount()
    expect((navigation().getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(true)
    const noteId = typeNote(editor)
    await click('Continue')
    await screen.findByRole('heading', { name: 'Connect your AI' })
    expect(useOnboardingStore.getState().progress?.noteId).toBe(noteId)
    await click('Skip for now')
    await screen.findByRole('heading', { name: 'Make room for more' })
    const choices = screen.getAllByRole('checkbox')
    expect(choices.every(choice => !(choice as HTMLInputElement).checked)).toBe(true)
    fireEvent.click(choices[0])
    expect(install).not.toHaveBeenCalled()
    await click('Skip for now')
    await screen.findByRole('heading', { name: 'Connect your tools' })
    expect(scan).not.toHaveBeenCalled()
    await click('Skip for now')
    await screen.findByRole('heading', { name: 'Your outline is ready' })
    await click('Open Forage')
    expect(useOnboardingStore.getState().progress?.status).toBe('completed')
    expect(document.querySelector<HTMLElement & { editor: Editor }>('.tiptap')?.editor).toBe(editor)
    expect(findBullet(editor.state.doc, noteId)?.text).toBe('Plan a useful project')
    expect(scan).not.toHaveBeenCalled(); expect(install).not.toHaveBeenCalled()
  })
  it('keeps failed edits pending, blocks Continue even after dismissal, and advances only after retry', async () => {
    let session: OutlineSession | undefined
    const open = OutlineSession.prototype.open
    vi.spyOn(OutlineSession.prototype, 'open').mockImplementation(function (this: OutlineSession) { session = this; return open.call(this) })
    const { editor } = await mount()
    fixture.failAppend = true; typeNote(editor)
    await screen.findByText('Outline not saved.')
    await click('Continue', false)
    expect(useOnboardingStore.getState().progress?.step).toBe('note')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    await click('Continue', false)
    expect(useOnboardingStore.getState().progress?.step).toBe('note')
    fixture.failAppend = false
    await act(async () => { await session!.retrySave() })
    await click('Continue')
    await screen.findByRole('heading', { name: 'Connect your AI' })
  })
  it('requires explicit model confirmation and dispatches one command with saved output on revisits', async () => {
    const { editor } = await mount(); typeNote(editor); await click('Continue')
    act(() => useSettingsStore.setState({ localCredentials: [{ id: 'local-openai', provider: 'openai', status: 'connected' }], localCompute: { provider: 'openai', credentialRef: 'local-openai', modelId: 'gpt-5.5' } }))
    await click('Confirm model & continue')
    await screen.findByRole('heading', { name: 'Explore your note' })
    const execution = vi.spyOn(skillExecution, 'execute').mockImplementation((request) => {
      const invocation = findBullet(request.editor.state.doc, request.invocationNodeId)!
      request.editor.view.dispatch(request.editor.state.tr.insert(invocation.pos + invocation.node.nodeSize - 1, request.editor.schema.nodes.bulletList.create(null, request.editor.schema.nodes.listItem.create({ nodeId: 'idea', nodeType: 'ai' }, request.editor.schema.nodes.paragraph.create(null, request.editor.schema.text('A real editable idea'))))))
      return { runId: 'run', cancel: vi.fn(), completion: Promise.resolve() }
    })
    vi.spyOn(OutlineSession.prototype, 'agentRun').mockResolvedValue({ status: 'completed', result: { version: 1, nodes: [{ type: 'text', text: 'A real editable idea' }] } } as LocalAgentRun)
    fireEvent.submit(screen.getByRole('form', { name: 'First command' }))
    await screen.findByRole('heading', { name: 'Make the ideas your own' }, { timeout: 8000 })
    expect(execution).toHaveBeenCalledTimes(1)
    await click('Continue'); await click('Back')
    expect(execution).toHaveBeenCalledTimes(1)
    expect(findBullet(editor.state.doc, 'idea')?.text).toBe('A real editable idea')
  })
  it('pauses explicitly and resumes from General without losing the note', async () => {
    const { editor } = await mount(); const id = typeNote(editor); await click('Continue'); await click('Finish later')
    expect(useOnboardingStore.getState().progress?.status).toBe('paused')
    fireEvent.keyDown(window, { key: ',', metaKey: true })
    fireEvent.click(await screen.findByRole('button', { name: 'Resume setup' }))
    await screen.findByRole('heading', { name: 'Connect your AI' })
    expect(findBullet(editor.state.doc, id)?.text).toBe('Plan a useful project')
  })
  it('uses the chosen outline pane during manual setup and retains both editor adapters', async () => {
    const { editor } = await mount(); typeNote(editor); await click('Skip setup')
    fireEvent.click(await screen.findByRole('button', { name: 'Pane actions' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /^Split right/ }))
    await waitFor(() => expect(document.querySelectorAll('.workspace-outline-pane')).toHaveLength(2))
    const editors = [...document.querySelectorAll<HTMLElement & { editor: Editor }>('.tiptap')].map(element => element.editor)
    fireEvent.keyDown(window, { key: ',', metaKey: true })
    fireEvent.click(await screen.findByRole('button', { name: 'Start setup' }))
    await screen.findByRole('heading', { name: 'Start with a note' })
    const panes = [...document.querySelectorAll<HTMLElement>('.workspace-outline-pane')]
    await waitFor(() => expect(panes.filter(pane => pane.dataset.onboardingEditor === 'true')).toHaveLength(1))
    expect(panes[1].dataset.onboardingEditor).toBe('true')
    await click('Skip setup')
    expect([...document.querySelectorAll<HTMLElement & { editor: Editor }>('.tiptap')].map(element => element.editor)).toEqual(editors)
    expect(editors[0]).toBe(editor)
  })
  it.each([
    { kind: 'note', step: 'note', message: 'Your setup note is no longer available.' },
    { kind: 'credential', step: 'ai', message: 'Your saved AI selection is unavailable or changed.' },
    { kind: 'run', step: 'command', message: 'The previous command did not finish.' },
    { kind: 'extension', step: 'extensions', message: 'An extension source changed or is unavailable.' },
    { kind: 'mcp', step: 'mcp', message: 'An MCP connection changed or is unavailable.' },
  ])('repairs an unavailable $kind reference on resume without external work', async ({ kind, step, message }) => {
    const { editor } = await mount(); const noteId = typeNote(editor)
    await click('Continue'); await click('Finish later')
    const compute = { provider: 'openai' as const, credentialRef: 'local-openai', modelId: 'gpt-5.5' }
    if (kind === 'credential') {
      act(() => useSettingsStore.setState({ localCredentials: [{ id: compute.credentialRef, provider: 'openai', status: 'connected' }], localCompute: compute }))
      const invoke = fixture.invoke.getMockImplementation()!
      fixture.invoke.mockImplementation(async (command, ...args) => {
        if (command === 'local_credential_load') throw new Error('Credential revoked')
        return invoke(command, ...args)
      })
    }
    vi.spyOn(OutlineSession.prototype, 'agentRun').mockResolvedValue(null)
    const execution = vi.spyOn(skillExecution, 'execute')
    await act(async () => useOnboardingStore.getState().update({
      step: 'complete',
      ...(kind === 'note' ? { noteId: 'deleted-note' } : {}),
      ...(kind === 'credential' ? { compute } : {}),
      ...(kind === 'run' ? { invocationId: noteId, runId: 'interrupted-run' } : {}),
      ...(kind === 'extension' ? { extensions: [{ installationId: 'changed-source', revision: 'old-revision' }] } : {}),
      ...(kind === 'mcp' ? { mcp: [{ id: 'changed-connection', fingerprint: 'old-fingerprint' }] } : {}),
    }))
    fireEvent.keyDown(window, { key: ',', metaKey: true })
    fireEvent.click(await screen.findByRole('button', { name: 'Resume setup' }))
    await screen.findByText(new RegExp(message.replace(/[.]/g, '\\.')), {}, { timeout: 8000 })
    expect(useOnboardingStore.getState().progress?.step).toBe(step)
    expect(execution).not.toHaveBeenCalled(); expect(scan).not.toHaveBeenCalled(); expect(install).not.toHaveBeenCalled()
    expect(findBullet(editor.state.doc, noteId)?.text).toBe('Plan a useful project')
  })
})
