import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { McpSettings } from './McpSettings'
import { useMcpStore } from '../../store/mcpStore'
import { useSettingsStore } from '../../store/settingsStore'
import { AgentSettings } from './AgentSettings'

vi.mock('../../agent/serverConfigurationSync', () => ({ publishLocalAgentConfiguration: vi.fn(async () => 'local_only') }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
const initialMcp = useMcpStore.getState()
const initialSettings = useSettingsStore.getState()
beforeEach(() => {
  vi.mocked(invoke).mockReset()
  vi.mocked(invoke).mockResolvedValue('local')
  useMcpStore.setState({ ...initialMcp, loaded: true, connections: [], serverConnections: [], busy: false, error: null,
    discovery: { candidates: [], warnings: [] }, scanConnections: vi.fn(async () => undefined),
  })
  useSettingsStore.setState({ ...initialSettings, isLoaded: true, enabledToolIds: [], setToolEnabled: vi.fn(async () => undefined) })
})
afterEach(() => { cleanup(); useMcpStore.setState(initialMcp); useSettingsStore.setState(initialSettings) })

describe('MCP settings', () => {
  it('discovers without connecting and offers tools and agent access after explicit connection', async () => {
    const candidate = { id: 'd'.repeat(64), name: 'Pen', sources: ['Codex'], transport: 'stdio' as const, inputs: [] }
    const connection = { id: 'pen', discoveryId: candidate.id, name: 'Pen', environment: 'local' as const, enabled: true, tools: [{
      id: `mcp_l_${'a'.repeat(48)}`, remoteName: 'execute', name: 'Edit design', description: 'Edit the Pen document', fingerprint: 'a'.repeat(64), inputSchema: { type: 'object' },
    }] }
    const connect = vi.fn(async () => { useMcpStore.setState({ connections: [connection] }); return connection })
    const grant = vi.fn(async () => undefined)
    useSettingsStore.setState({ agents: [{ id: 'designer', name: 'Designer', description: '', systemPrompt: 'Design.', toolIds: [] }], grantMcpToolAccess: grant })
    const scan = vi.fn(async () => { useMcpStore.setState({ discovery: { candidates: [candidate], warnings: [] } }) })
    useMcpStore.setState({ scanConnections: scan, connectCandidate: connect })
    render(<McpSettings />)
    const found = await screen.findByRole('group', { name: 'Found Pen' })
    expect(scan).toHaveBeenCalledTimes(1)
    expect(connect).not.toHaveBeenCalled()
    expect(grant).not.toHaveBeenCalled()
    expect(within(found).getByText(/Found in Codex/)).toBeTruthy()
    fireEvent.click(within(found).getByRole('button', { name: 'Connect' }))
    const access = await screen.findByRole('group', { name: 'Tool access for Pen' })
    expect(connect).toHaveBeenCalledWith(candidate.id, {}, 'Pen')
    expect(grant).not.toHaveBeenCalled()
    expect((within(access).getByRole('button', { name: 'Enable for selected agents' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(within(access).getByRole('checkbox', { name: 'Designer' }))
    fireEvent.click(within(access).getByRole('button', { name: 'Enable for selected agents' }))
    await waitFor(() => expect(grant).toHaveBeenCalledWith([connection.tools[0]!.id], ['designer']))
    expect(await screen.findByText('Already connected')).toBeTruthy()
  })

  it('requests missing credentials, clears them after import, and keeps changed-source failures retryable', async () => {
    const candidate = { id: 'c'.repeat(64), name: 'Search', sources: ['VS Code'], transport: 'http' as const, inputs: [{ key: 'header:Authorization', label: 'Authorization header' }] }
    const connection = { id: 'search', discoveryId: candidate.id, name: 'Search', environment: 'local' as const, enabled: true, tools: [] }
    const connect = vi.fn().mockRejectedValueOnce(new Error('This connection changed. Scan again.')).mockImplementationOnce(async () => { useMcpStore.setState({ connections: [connection] }); return connection })
    useMcpStore.setState({ discovery: { candidates: [candidate], warnings: [] }, connectCandidate: connect })
    render(<McpSettings />)
    const found = await screen.findByRole('group', { name: 'Found Search' })
    expect((within(found).getByText('Connect') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(within(found).getByLabelText('Authorization header'), { target: { value: 'Bearer private-value' } })
    fireEvent.click(within(found).getByText('Connect'))
    expect((await screen.findByRole('alert')).textContent).toContain('Scan again')
    fireEvent.click(within(found).getByText('Connect'))
    await waitFor(() => expect(connect).toHaveBeenLastCalledWith(candidate.id, { 'header:Authorization': 'Bearer private-value' }, 'Search'))
    await waitFor(() => expect(screen.queryByLabelText('Authorization header')).toBeNull())
  })

  it('connects by URL with an optional token and clears credentials after success', async () => {
    const connect = vi.fn(async () => undefined)
    useMcpStore.setState({ addConnection: connect })
    render(<McpSettings />)
    fireEvent.change(await screen.findByLabelText('Server name'), { target: { value: 'My search server' } })
    fireEvent.change(screen.getByLabelText('Server URL'), { target: { value: 'https://search.example/mcp' } })
    fireEvent.change(screen.getByLabelText('Access token (optional)'), { target: { value: 'private-token' } })
    fireEvent.click(screen.getByText('Connect server'))
    await waitFor(() => expect(connect).toHaveBeenCalledWith('My search server', { url: 'https://search.example/mcp', headers: { Authorization: 'Bearer private-token' } }))
    await waitFor(() => expect((screen.getByLabelText('Access token (optional)') as HTMLInputElement).value).toBe(''))
    expect(screen.queryByRole('button', { name: 'This device' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Forage backend' })).toBeNull()
    expect(invoke).toHaveBeenCalledWith('event_store_storage_mode')
  })

  it('connects a quoted launch command with environment fields without shell execution', async () => {
    const connect = vi.fn(async () => undefined)
    useMcpStore.setState({ addConnection: connect })
    render(<McpSettings />)
    fireEvent.change(await screen.findByLabelText('Server name'), { target: { value: 'Local index' } })
    fireEvent.change(screen.getByLabelText('Connect using'), { target: { value: 'command' } })
    fireEvent.change(screen.getByLabelText('Launch command'), { target: { value: 'npx -y custom-mcp --folder "/My Documents"' } })
    fireEvent.click(screen.getByText('Add environment variable'))
    fireEvent.change(screen.getByLabelText('Environment variable name 1'), { target: { value: 'TOKEN' } })
    fireEvent.change(screen.getByLabelText('Environment variable value 1'), { target: { value: 'private-value' } })
    fireEvent.click(screen.getByText('Connect server'))
    await waitFor(() => expect(connect).toHaveBeenCalledWith('Local index', { command: 'npx', args: ['-y', 'custom-mcp', '--folder', '/My Documents'], env: { TOKEN: 'private-value' } }))
    await waitFor(() => expect((screen.getByLabelText('Launch command') as HTMLInputElement).value).toBe(''))
    expect(screen.queryByLabelText('Environment variable value 1')).toBeNull()
  })

  it('keeps the form editable after a connection failure', async () => {
    useMcpStore.setState({ addConnection: vi.fn(async () => { throw new Error('Server unavailable') }) })
    render(<McpSettings />)
    fireEvent.change(await screen.findByLabelText('Server name'), { target: { value: 'Search' } })
    fireEvent.change(screen.getByLabelText('Server URL'), { target: { value: 'https://search.example/mcp' } })
    fireEvent.click(screen.getByText('Connect server'))
    expect((await screen.findByRole('alert')).textContent).toContain('Server unavailable')
    expect((screen.getByLabelText('Server URL') as HTMLInputElement).value).toBe('https://search.example/mcp')
    expect((screen.getByText('Connect server') as HTMLButtonElement).disabled).toBe(false)
  })

  it('connects user-supplied configuration and clears credential-bearing form text on success', async () => {
    const connect = vi.fn(async () => undefined)
    useMcpStore.setState({ importConnections: connect })
    render(<McpSettings />)
    fireEvent.click(await screen.findByText('Advanced: import JSON'))
    const input = screen.getByLabelText('Server configuration')
    const config = '{"mcpServers":{"mine":{"url":"https://custom.example/mcp","headers":{"Authorization":"Bearer secret"}}}}'
    fireEvent.change(input, { target: { value: config } })
    fireEvent.click(screen.getByText('Import and connect'))
    await waitFor(() => expect(connect).toHaveBeenCalledWith(config))
    await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe(''))
  })

  it('shows discovered tools disabled until the user enables one', async () => {
    const id = `mcp_l_${'a'.repeat(48)}`
    useMcpStore.setState({ connections: [{ id: 'mine', name: 'Mine', environment: 'local', enabled: true, tools: [{
      id, remoteName: 'lookup', name: 'Lookup', description: 'Find a record', fingerprint: 'a'.repeat(64), inputSchema: { type: 'object' },
    }] }] })
    render(<McpSettings />)
    const toggle = await screen.findByRole('checkbox', { name: 'Enable Mine · Lookup' }) as HTMLInputElement
    expect(toggle.checked).toBe(false)
    fireEvent.click(toggle)
    await waitFor(() => expect(useSettingsStore.getState().setToolEnabled).toHaveBeenCalledWith(id, true))
  })

  it('loads backend tools automatically and never falls back to a local form on failure', async () => {
    vi.mocked(invoke).mockResolvedValue('server')
    const loadServer = vi.fn(async () => { throw new Error('Backend is disconnected') })
    useMcpStore.setState({ loadServer })
    render(<McpSettings />)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Backend is disconnected'))
    expect(screen.queryByLabelText('Server configuration')).toBeNull()
    expect(screen.queryByLabelText('Server name')).toBeNull()
    expect(useMcpStore.getState().scanConnections).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Refresh tools'))
    await waitFor(() => expect(loadServer).toHaveBeenCalledTimes(2))
  })

  it('offers retry instead of assuming local mode when the mode cannot be read', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('Could not read compute mode'))
    render(<McpSettings />)
    expect((await screen.findByRole('alert')).textContent).toContain('Could not read compute mode')
    expect(screen.queryByLabelText('Server name')).toBeNull()
    fireEvent.click(screen.getByText('Try again'))
    expect(await screen.findByLabelText('Server name')).toBeTruthy()
  })

  it('shows only active backend tools in Settings and the agent picker', async () => {
    vi.mocked(invoke).mockResolvedValue('server')
    const local = { id: 'local', name: 'Device only', environment: 'local' as const, enabled: true, tools: [{
      id: `mcp_l_${'a'.repeat(48)}`, remoteName: 'lookup', name: 'Lookup', description: 'Find a record', fingerprint: 'a'.repeat(64), inputSchema: { type: 'object' },
    }] }
    const server = { ...local, id: 'backend', name: 'Shared search', environment: 'server' as const, tools: [{ ...local.tools[0]!, id: `mcp_s_${'b'.repeat(48)}` }] }
    const loadServer = vi.fn(async () => { useMcpStore.setState({ serverConnections: [server] }) })
    useMcpStore.setState({ connections: [local], loadServer })
    const view = render(<McpSettings />)
    expect(await screen.findByRole('checkbox', { name: 'Enable Shared search · Lookup' })).toBeTruthy()
    expect(screen.queryByText('Device only')).toBeNull()
    expect(screen.queryByLabelText('Server name')).toBeNull()
    view.unmount()
    render(<AgentSettings reportError={vi.fn()} />)
    await waitFor(() => expect(loadServer).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getByText('Add agent'))
    expect(await screen.findByRole('checkbox', { name: 'Shared search · Lookup' })).toBeTruthy()
    expect(screen.queryByRole('checkbox', { name: 'Device only · Lookup' })).toBeNull()
  })
})
