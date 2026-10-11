import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { BulletAttributes } from '../editor/extensions'
import { NativeEventRepository } from '../persistence/eventStore'
import { useSettingsStore } from '../store/settingsStore'
import { useExtensionStore } from '../store/extensionStore'
import { useMcpStore } from '../store/mcpStore'
import { currentListItemId } from './insertIntoEditor'
import { LocalAgentExecutor } from './localExecutor'
import { nativeLocalCredentialVault } from './localCredentials'
import { serverRunManager } from './serverRunManager'
import { skillExecution } from './skillExecution'
import { runInputSchema } from '@forage/agent-runtime'

const allowedTool = {
  id: `mcp_l_${'a'.repeat(48)}`, remoteName: 'search', name: 'Search',
  description: 'Search data', inputSchema: { type: 'object' }, fingerprint: 'a'.repeat(64),
}
const deniedTool = { ...allowedTool, id: `mcp_l_${'b'.repeat(48)}`, remoteName: 'write', fingerprint: 'b'.repeat(64) }

describe('skill execution application service', () => {
  let editor: Editor
  const initialSettings = useSettingsStore.getState()
  const initialExtensions = useExtensionStore.getState()
  const initialMcp = useMcpStore.getState()

  beforeEach(() => {
    useSettingsStore.setState({
      ...initialSettings,
      authMode: 'api_key', modelId: 'gpt-5',
      localCompute: { provider: 'openai', modelId: 'gpt-5', credentialRef: 'local-openai' },
      localCredentials: [{ id: 'local-openai', provider: 'openai', status: 'connected' }],
      agents: [{ id: 'agent', name: 'Agent', description: '', systemPrompt: 'Help.', toolIds: [allowedTool.id] }],
      skills: [{ id: 'ask', label: 'ask', description: '', execution: 'llm', agentId: 'agent', systemPrompt: 'Answer.', requiredToolIds: [] }],
      enabledToolIds: [allowedTool.id, deniedTool.id], customTools: [],
    })
    useExtensionStore.setState({
      ...initialExtensions,
      catalog: { version: 1, revision: 'a'.repeat(64), entries: [] },
      configuration: { version: 1, revision: 1, sources: [] },
    })
    useMcpStore.setState({
      ...initialMcp, loaded: true,
      connections: [{ id: 'fixture', name: 'Fixture', environment: 'local', enabled: true, tools: [allowedTool, deniedTool] }],
    })
    editor = new Editor({
      element: document.createElement('div'),
      extensions: [StarterKit.configure({ trailingNode: false }), BulletAttributes],
      content: '<ul><li><p>/ask question</p></li></ul>',
    })
    editor.commands.setTextSelection(5)
    vi.spyOn(NativeEventRepository.prototype, 'storageMode').mockResolvedValue('local')
    vi.spyOn(NativeEventRepository.prototype, 'identity').mockResolvedValue({ outlineId: 'outline', actorId: 'actor', deviceId: 'device' })
  })

  afterEach(() => {
    editor.destroy()
    vi.restoreAllMocks()
    useSettingsStore.setState(initialSettings, true)
    useExtensionStore.setState(initialExtensions, true)
    useMcpStore.setState(initialMcp, true)
  })

  function request() {
    return {
      editor, skillId: 'ask', invocationNodeId: currentListItemId(editor)!, prompt: 'Why?',
      conversation: { callId: 'first-run', turn: 2 },
    }
  }

  it('resolves local tools and MCP snapshots without requiring the invoking UI to supply them', async () => {
    const invoke = vi.spyOn(LocalAgentExecutor.prototype, 'invoke').mockImplementation(async (input) => ({
      runId: input.runId, cancel: vi.fn(async () => {}),
      completion: Promise.resolve({ version: 1, type: 'answer', text: 'Because.' }),
    }))
    const onError = vi.fn()
    const onActivity = vi.fn()
    const handle = skillExecution.execute(request(), { onError, onActivity })
    await handle.completion

    expect(invoke).toHaveBeenCalledOnce()
    const input = invoke.mock.calls[0]![0]
    expect(input).toMatchObject({
      runId: handle.runId, executionMode: 'local', credentialRef: 'local-openai',
      effectiveToolIds: [allowedTool.id],
      mcpSnapshot: [{ id: 'fixture', tools: [allowedTool] }],
      thread: { callId: 'first-run', turn: 2 },
    })
    expect(onError).toHaveBeenLastCalledWith(null)
    expect(onActivity).toHaveBeenCalledWith(expect.objectContaining({ phase: 'complete', answer: 'Because.' }))
  })

  it.each([false, true])('normalizes UUID custom-tool references alongside MCP tools without changing saved permissions (required: %s)', async (required) => {
    const customTool = { id: '550e8400-e29b-41d4-a716-446655440000', name: 'public_weather', description: 'Read public weather', urlTemplate: 'https://api.open-meteo.com/v1/forecast?latitude={{latitude}}' }
    const agent = { ...useSettingsStore.getState().agents[0]!, toolIds: ['web_search', 'web_fetch', 'search_outline', allowedTool.id, customTool.id] }
    const skill = { ...useSettingsStore.getState().skills[0]!, requiredToolIds: required ? [customTool.id] : [] }
    useSettingsStore.setState({ agents: [agent], skills: [skill], customTools: [customTool], enabledToolIds: ['web_search', 'search_outline', allowedTool.id, customTool.id] })
    const invoke = vi.spyOn(LocalAgentExecutor.prototype, 'invoke').mockImplementation(async (input) => {
      runInputSchema.parse(input)
      return { runId: input.runId, cancel: vi.fn(async () => {}), completion: Promise.resolve({ version: 1, type: 'answer', text: 'Because.' }) }
    })
    const onError = vi.fn()
    await skillExecution.execute(request(), { onError }).completion

    expect(onError).toHaveBeenLastCalledWith(null)
    expect(invoke.mock.calls[0]![0]).toMatchObject({
      agent: { toolIds: ['web_search', 'web_fetch', 'search_outline', allowedTool.id, customTool.name] },
      effectiveToolIds: ['web_search', 'search_outline', allowedTool.id, customTool.name],
      skill: { requiredToolIds: required ? [customTool.name] : [] },
      customTools: [{ ...customTool, id: customTool.name }],
      mcpSnapshot: [{ id: 'fixture', tools: [allowedTool] }],
    })
    expect(useSettingsStore.getState().agents).toEqual([agent])
    expect(useSettingsStore.getState().skills).toEqual([skill])
    expect(useSettingsStore.getState().customTools).toEqual([customTool])
  })

  it('does not admit a globally disabled custom tool while preserving its saved reference', async () => {
    const customTool = { id: '550e8400-e29b-41d4-a716-446655440000', name: 'public_weather', description: 'Read public weather', urlTemplate: 'https://api.open-meteo.com/v1/forecast?latitude={{latitude}}' }
    useSettingsStore.setState({
      agents: [{ ...useSettingsStore.getState().agents[0]!, toolIds: [allowedTool.id, customTool.id] }],
      customTools: [customTool],
    })
    const invoke = vi.spyOn(LocalAgentExecutor.prototype, 'invoke').mockImplementation(async (input) => {
      runInputSchema.parse(input)
      return { runId: input.runId, cancel: vi.fn(async () => {}), completion: Promise.resolve({ version: 1, type: 'answer', text: 'Because.' }) }
    })
    const onError = vi.fn()
    await skillExecution.execute(request(), { onError }).completion
    expect(onError).toHaveBeenLastCalledWith(null)
    expect(invoke.mock.calls[0]![0]).toMatchObject({ agent: { toolIds: [allowedTool.id, customTool.name] }, effectiveToolIds: [allowedTool.id], customTools: [] })
    expect(useSettingsStore.getState().agents[0]!.toolIds).toEqual([allowedTool.id, customTool.id])
  })

  it('rejects a custom tool alias that would reuse an MCP permission identity', async () => {
    const customTool = { id: '550e8400-e29b-41d4-a716-446655440000', name: allowedTool.id, description: 'Conflicting tool', urlTemplate: 'https://api.open-meteo.com/v1/forecast?latitude={{latitude}}' }
    useSettingsStore.setState({ customTools: [customTool] })
    const invoke = vi.spyOn(LocalAgentExecutor.prototype, 'invoke')
    const onError = vi.fn()
    await skillExecution.execute(request(), { onError }).completion
    expect(onError).toHaveBeenLastCalledWith(expect.stringContaining('conflicts with another tool'))
    expect(invoke).not.toHaveBeenCalled()
    expect(useSettingsStore.getState().agents[0]!.toolIds).toEqual([allowedTool.id])
  })

  it('submits backend intent without loading local credentials or tool inventory', async () => {
    vi.mocked(NativeEventRepository.prototype.storageMode).mockResolvedValue('server')
    vi.spyOn(NativeEventRepository.prototype, 'serverConnection').mockResolvedValue({ origin: 'https://example.test', instanceId: 'instance', outlineId: 'outline' })
    vi.spyOn(NativeEventRepository.prototype, 'syncState').mockResolvedValue({ outlineId: 'outline', lastAckedRevision: 7, lastPulledRevision: 8, serverInstanceId: 'instance' })
    useSettingsStore.setState({ localCredentials: [] })
    useMcpStore.setState({ loaded: false })
    const loadInventory = vi.spyOn(useMcpStore.getState(), 'load')
    const loadCredential = vi.spyOn(nativeLocalCredentialVault, 'load')
    const localInvoke = vi.spyOn(LocalAgentExecutor.prototype, 'invoke')
    const invoke = vi.spyOn(serverRunManager, 'invoke').mockResolvedValue({
      runId: 'server-run', cancel: vi.fn(async () => {}),
      completion: Promise.resolve({
        id: 'server-run', outlineId: 'outline', trigger: 'manual', status: 'completed',
        skillId: 'ask', policyId: null, configurationRevision: 1, attemptCount: 1,
        admittedAt: '2026-09-27T10:00:00.000Z', updatedAt: '2026-09-27T10:00:01.000Z',
        retryOfRunId: null, error: null, result: null, placementError: null,
        callId: 'first-run', turn: 2, sourceNodeId: currentListItemId(editor)!, prompt: 'Why?', answer: 'Because.',
      }),
    })
    const onError = vi.fn()
    const handle = skillExecution.execute(request(), { onError })
    await handle.completion

    expect(invoke.mock.calls[0]![0]).toEqual({
      version: 2, invocationId: handle.runId, sourceNodeId: currentListItemId(editor),
      skillId: 'ask', prompt: 'Why?', acknowledgedOutlineRevision: 8,
      conversation: { callId: 'first-run', turn: 2 },
    })
    expect(localInvoke).not.toHaveBeenCalled()
    expect(loadInventory).not.toHaveBeenCalled()
    expect(loadCredential).not.toHaveBeenCalled()
    expect(onError).toHaveBeenLastCalledWith(null)
  })

  it('cancels while admission is pending without starting an executor or changing the outline', async () => {
    let admit!: (mode: 'local') => void
    vi.mocked(NativeEventRepository.prototype.storageMode).mockReturnValue(new Promise((resolve) => { admit = resolve }))
    const invoke = vi.spyOn(LocalAgentExecutor.prototype, 'invoke')
    const before = editor.getJSON()
    const onError = vi.fn()
    const onActivity = vi.fn()
    const handle = skillExecution.execute({ ...request(), conversation: undefined }, { onError, onActivity })
    handle.cancel()
    admit('local')
    await handle.completion

    expect(invoke).not.toHaveBeenCalled()
    expect(editor.getJSON()).toEqual(before)
    expect(onActivity).toHaveBeenCalledWith(expect.objectContaining({ id: handle.runId, phase: 'cancelled' }))
    expect(onError).toHaveBeenLastCalledWith(null)
  })

  it('forwards cancellation to the admitted executor', async () => {
    let rejectCompletion!: (error: Error) => void
    const cancel = vi.fn(async () => { rejectCompletion(new DOMException('Cancelled', 'AbortError')) })
    vi.spyOn(LocalAgentExecutor.prototype, 'invoke').mockImplementation(async (input) => ({
      runId: input.runId, cancel,
      completion: new Promise((_resolve, reject) => { rejectCompletion = reject }),
    }))
    const onActivity = vi.fn()
    const handle = skillExecution.execute(request(), { onError: vi.fn(), onActivity })
    await vi.waitFor(() => expect(rejectCompletion).toBeDefined())
    handle.cancel()
    await handle.completion

    expect(cancel).toHaveBeenCalledOnce()
    expect(onActivity).toHaveBeenCalledWith(expect.objectContaining({ phase: 'cancelled' }))
  })

  it('reports a deleted skill through the service without attempting execution', async () => {
    const onError = vi.fn()
    const handle = skillExecution.execute({ ...request(), skillId: 'deleted' }, { onError })
    await handle.completion
    expect(onError).toHaveBeenCalledWith('The selected skill no longer exists.')
    expect(NativeEventRepository.prototype.storageMode).not.toHaveBeenCalled()
  })
})
