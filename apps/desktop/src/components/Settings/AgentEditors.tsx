import { useRef, useState } from 'react'
import { validateExtensionSkillConfiguration } from '@forage/agent-runtime'
import type { AgentDefinition, AgentDraft, ExtensionSkillDraft, SkillDraft } from '../../agent/definitions'
import type { ToolOption } from '../../agent/tools'
import type { ExtensionExecutorOption } from '../../store/extensionStore'
import { InheritedCompute } from './InheritedCompute'
import { Button } from '../ui/Button'
import { Field, Input, Select, Textarea } from '../ui/Field'
import { configurationWithDefaults, configurationWithoutUndeclaredFields, ExtensionSkillConfigurationForm, type ConfigurationIssue } from './ExtensionSkillConfigurationForm'
import { useDraftExit } from './useDraftExit'
import type { McpConnection } from '@forage/agent-runtime'
import { AgentMcpTools, mcpReviewIdentity } from './AgentMcpTools'
import { useSettingsStore } from '../../store/settingsStore'
import { AgentToolChoice } from './AgentToolChoice'
import { Check, Pencil, X } from 'lucide-react'

export interface SelectorTool extends ToolOption {
  group: string
  available: boolean
  isExtension?: boolean
  unavailableReason?: string
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)

function useInlineSave<T>(onSave: (draft: T) => Promise<void>) {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const saving = useRef(false)
  return {
    busy,
    error,
    save: async (draft: T) => {
      if (saving.current) return
      saving.current = true
      setBusy(true)
      setError(null)
      try { await onSave(draft) } catch (saveError) { setError(errorMessage(saveError)) }
      finally { saving.current = false; setBusy(false) }
    },
  }
}

export function AgentForm({ initial, tools, connections, onSave, onCancel }: {
  initial: AgentDraft; tools: SelectorTool[]; connections: McpConnection[]; onSave: (draft: AgentDraft) => Promise<void>; onCancel: () => void
}) {
  const [draft, setDraft] = useState(initial)
  const reviews = useRef(new Map<string, string>())
  const { error, busy, save } = useInlineSave(async (candidate: AgentDraft) => {
    for (const id of candidate.toolIds.filter((toolId) => toolId.startsWith('mcp_') && !initial.toolIds.includes(toolId))) {
      const connection = connections.find((entry) => entry.tools.some((tool) => tool.id === id))
      if (!connection || reviews.current.get(connection.id) !== mcpReviewIdentity(connection) || !useSettingsStore.getState().enabledToolIds.includes(id)) throw new Error('MCP tools changed or are globally disabled. Review Choose tools again before saving.')
    }
    await onSave(candidate); exit.allowExit(); onCancel()
  })
  const exit = useDraftExit(JSON.stringify(draft) !== JSON.stringify(initial), busy, onCancel)
  const update = <K extends keyof AgentDraft>(key: K, value: AgentDraft[K]) => setDraft((before) => ({ ...before, [key]: value }))
  return <div className="custom-tool-form agent-form" role="group" aria-label="Agent editor">
    <Field label="Name"><div className="settings-editable-field"><Input disabled={busy} autoFocus aria-label="Agent name" value={draft.name} onChange={(event) => update('name', event.target.value)} /><Pencil size={14} aria-hidden="true" /></div></Field>
    <Field label="Description"><div className="settings-editable-field"><Input disabled={busy} aria-label="Agent description" value={draft.description} onChange={(event) => update('description', event.target.value)} /><Pencil size={14} aria-hidden="true" /></div></Field>
    <Field label="Instructions"><Textarea disabled={busy} aria-label="Agent instructions" value={draft.systemPrompt} onChange={(event) => update('systemPrompt', event.target.value)} /></Field>
    <InheritedCompute />
    <fieldset disabled={busy} className="agent-tool-list settings-agent-tools"><legend>Tools</legend><p className="settings-hint">Choose the tools and MCP servers this agent can use.</p><div>{tools.filter((tool) => tool.group !== 'MCP').map((tool) => <AgentToolChoice
      key={tool.id} checked={draft.toolIds.includes(tool.id)} name={tool.name} source={tool.group} description={tool.description}
      unavailableReason={!tool.available ? tool.unavailableReason ?? 'provider missing' : undefined}
      disabled={!tool.available && !draft.toolIds.includes(tool.id)} onChange={(checked) => update('toolIds', checked ? [...draft.toolIds, tool.id] : draft.toolIds.filter((id) => id !== tool.id))}
    />)}</div>
    <AgentMcpTools connections={connections} selected={draft.toolIds} onChange={(ids) => update('toolIds', ids)} onReview={(connection) => reviews.current.set(connection.id, mcpReviewIdentity(connection))} /></fieldset>
    {error && <p className="settings-error" role="alert">{error}</p>}
    <div className="settings-actions"><Button variant="primary" icon={<Check aria-hidden="true" />} disabled={busy} onClick={() => void save(draft)}>Save agent</Button><Button icon={<X aria-hidden="true" />} disabled={busy} onClick={exit.cancel}>Cancel</Button></div>
    <p className="settings-hint settings-footnote">Changes apply the next time this agent runs.</p>
    {exit.dialog}
  </div>
}

function executorValue(executor: { extensionId: string; executorId: string }): string {
  return `${executor.extensionId}/${executor.executorId}`
}

export function SkillForm({ initial, agents, tools, executors, onSave, onCancel }: {
  initial: SkillDraft; agents: AgentDefinition[]; tools: SelectorTool[]; executors: ExtensionExecutorOption[]
  onSave: (draft: SkillDraft) => Promise<void>; onCancel: () => void
}) {
  const [draft, setDraft] = useState(initial)
  const [configurationIssues, setConfigurationIssues] = useState<ConfigurationIssue[]>([])
  const { error, busy, save } = useInlineSave(async (candidate: SkillDraft) => {
    if (candidate.execution === 'extension') {
      const executor = executors.find((option) => option.extensionId === candidate.executor.extensionId && option.executorId === candidate.executor.executorId)
      if (!executor?.available) throw new Error(executor?.unavailableReason ?? 'The selected extension executor is unavailable. Its saved configuration has been retained.')
      const configuration = configurationWithoutUndeclaredFields(executor.configuration, candidate.configuration)
      const validation = validateExtensionSkillConfiguration(executor.configuration, configuration)
      if (!validation.valid) {
        setConfigurationIssues(validation.issues)
        throw new Error('Fix the highlighted extension configuration fields before saving.')
      }
      await onSave({ ...candidate, configuration })
      exit.allowExit()
      onCancel()
      return
    }
    await onSave(candidate)
    exit.allowExit()
    onCancel()
  })
  const exit = useDraftExit(JSON.stringify(draft) !== JSON.stringify(initial), busy, onCancel)
  const selectedExecutor = draft.execution === 'extension'
    ? executors.find((option) => option.extensionId === draft.executor.extensionId && option.executorId === draft.executor.executorId)
    : undefined
  const retainedExecutor = draft.execution === 'extension' && !selectedExecutor
    ? {
      ...draft.executor, name: `${draft.executor.extensionId}/${draft.executor.executorId}`,
      description: 'This configured executor is missing or unavailable.', sourceName: 'Unavailable reference',
      installationId: '', allowEmptyPrompt: false, configuration: { fields: [] }, available: false,
      unavailableReason: 'The extension is not installed.',
    } satisfies ExtensionExecutorOption
    : undefined
  const executionOptions = [...executors, ...(retainedExecutor ? [retainedExecutor] : [])]
  const updateCommon = (key: 'label' | 'description', value: string) => setDraft((before) => ({ ...before, [key]: value }))
  const requiredToolIds = draft.execution === 'extension' ? [] : (draft.requiredToolIds ?? [])
  const agentTools = draft.execution === 'extension' ? [] : tools.filter((tool) => agents.find((agent) => agent.id === draft.agentId)?.toolIds.includes(tool.id))
  const chooseAgent = (agentId: string) => {
    const allowed = agents.find((agent) => agent.id === agentId)?.toolIds ?? []
    setDraft((before) => before.execution === 'extension' ? before : ({ ...before, agentId, requiredToolIds: (before.requiredToolIds ?? []).filter((id) => allowed.includes(id)) }))
  }
  const chooseExecution = (value: string) => {
    setConfigurationIssues([])
    if (value === 'llm') {
      setDraft((before): SkillDraft => ({
        ...(before.id ? { id: before.id } : {}), label: before.label, description: before.description,
        execution: 'llm', systemPrompt: '', agentId: agents[0]?.id ?? '', requiredToolIds: [],
      }))
      return
    }
    const executor = executors.find((option) => executorValue(option) === value)
    if (!executor?.available) return
    setDraft((before): ExtensionSkillDraft => ({
      ...(before.id ? { id: before.id } : {}), label: before.label, description: before.description,
      execution: 'extension', executor: { extensionId: executor.extensionId, executorId: executor.executorId },
      configuration: configurationWithDefaults(executor.configuration),
    }))
  }
  return <div className="custom-tool-form skill-form" role="group" aria-label="Skill editor">
    <Field label="Slash command"><div className="settings-editable-field"><Input disabled={busy} autoFocus mono aria-label="Slash command" value={draft.label} onChange={(event) => updateCommon('label', event.target.value)} /><Pencil size={14} aria-hidden="true" /></div></Field>
    <Field label="Description"><div className="settings-editable-field"><Input disabled={busy} aria-label="Skill description" value={draft.description} onChange={(event) => updateCommon('description', event.target.value)} /><Pencil size={14} aria-hidden="true" /></div></Field>
    <Field label="Execution"><Select disabled={busy} aria-label="Skill execution" value={draft.execution === 'extension' ? executorValue(draft.executor) : 'llm'} onChange={(event) => chooseExecution(event.target.value)}>
      <option value="llm">LLM agent</option>
      {executionOptions.map((executor) => <option key={executorValue(executor)} value={executorValue(executor)} disabled={!executor.available}>
        {executor.sourceName} · {executor.name}{executor.available ? '' : ' (unavailable)'}
      </option>)}
    </Select></Field>
    {draft.execution === 'extension' ? <>
      {selectedExecutor?.description && <p className="settings-hint">{selectedExecutor.description}</p>}
      {(selectedExecutor ?? retainedExecutor) && <fieldset disabled={busy}><ExtensionSkillConfigurationForm
        form={(selectedExecutor ?? retainedExecutor)!.configuration}
        configuration={draft.configuration}
        issues={configurationIssues}
        onChange={(configuration) => { setConfigurationIssues([]); setDraft((before) => before.execution === 'extension' ? { ...before, configuration } : before) }}
      /></fieldset>}
      {!selectedExecutor?.available && <p className="settings-error" role="alert">{selectedExecutor?.unavailableReason ?? retainedExecutor?.unavailableReason}</p>}
      {!selectedExecutor?.available && <details><summary>Retained configuration</summary><pre>{JSON.stringify(draft.configuration, null, 2)}</pre></details>}
    </> : <>
      <Field label="Agent"><Select disabled={busy} aria-label="Skill agent" value={draft.agentId} onChange={(event) => chooseAgent(event.target.value)}>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</Select></Field>
      <Field label="Workflow instructions"><Textarea disabled={busy} aria-label="Skill instructions" value={draft.systemPrompt} onChange={(event) => setDraft((before) => before.execution === 'extension' ? before : { ...before, systemPrompt: event.target.value })} /></Field>
      <fieldset disabled={busy} className="agent-tool-list settings-agent-tools"><legend>Required tools</legend><div>{agentTools.map((tool) => <AgentToolChoice
      key={tool.id} checked={requiredToolIds.includes(tool.id)} name={tool.name} source={tool.group} description={tool.description}
      unavailableReason={!tool.available ? tool.unavailableReason ?? 'provider missing' : undefined}
      disabled={!tool.available && !requiredToolIds.includes(tool.id)}
      onChange={(checked) => setDraft((before) => before.execution === 'extension' ? before : { ...before, requiredToolIds: checked ? [...requiredToolIds, tool.id] : requiredToolIds.filter((id) => id !== tool.id) })}
      />)}</div></fieldset>
    </>}
    {error && <p className="settings-error" role="alert">{error}</p>}
    <div className="settings-actions"><Button variant="primary" icon={<Check aria-hidden="true" />} disabled={busy} onClick={() => void save(draft)}>Save skill</Button><Button icon={<X aria-hidden="true" />} disabled={busy} onClick={exit.cancel}>Cancel</Button></div>
    {exit.dialog}
  </div>
}
