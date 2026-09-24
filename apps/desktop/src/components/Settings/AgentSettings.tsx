import { useId, useState } from 'react'
import { validateExtensionSkillConfiguration } from '@forage/agent-runtime'
import {
  isExtensionSkill,
  type AgentDefinition,
  type AgentDraft,
  type ExtensionSkillDraft,
  type SkillDefinition,
  type SkillDraft,
} from '../../agent/definitions'
import { publishLocalAgentConfiguration } from '../../agent/serverConfigurationSync'
import { BUILTIN_TOOL_OPTIONS, type ToolOption } from '../../agent/tools'
import { useSettingsStore } from '../../store/settingsStore'
import type { ExtensionExecutorOption, ExtensionToolOption } from '../../store/extensionStore'
import { SwitchFieldInput } from '../ui/SwitchFieldInput'
import { ConfirmButton } from './ConfirmButton'
import {
  configurationWithDefaults,
  configurationWithoutUndeclaredFields,
  ExtensionSkillConfigurationForm,
  type ConfigurationIssue,
} from './ExtensionSkillConfigurationForm'

interface SelectorTool extends ToolOption {
  group: string
  available: boolean
  isExtension?: boolean
  unavailableReason?: string
}

const EMPTY_AGENT: AgentDraft = { name: '', description: '', systemPrompt: '', toolIds: [] }
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)

function useInlineSave<T>(onSave: (draft: T) => Promise<void>) {
  const [error, setError] = useState<string | null>(null)
  return {
    error,
    save: async (draft: T) => {
      setError(null)
      try { await onSave(draft) } catch (saveError) { setError(errorMessage(saveError)) }
    },
  }
}

function AgentForm({ initial, tools, onSave, onCancel }: {
  initial: AgentDraft; tools: SelectorTool[]; onSave: (draft: AgentDraft) => Promise<void>; onCancel: () => void
}) {
  const [draft, setDraft] = useState(initial)
  const { error, save } = useInlineSave(onSave)
  const update = <K extends keyof AgentDraft>(key: K, value: AgentDraft[K]) => setDraft((before) => ({ ...before, [key]: value }))
  return <div className="custom-tool-form agent-form" role="group" aria-label="Agent editor">
    <label>Agent name<input aria-label="Agent name" value={draft.name} onChange={(event) => update('name', event.target.value)} /></label>
    <label>Description<input aria-label="Agent description" value={draft.description} onChange={(event) => update('description', event.target.value)} /></label>
    <label>Instructions<textarea aria-label="Agent instructions" value={draft.systemPrompt} onChange={(event) => update('systemPrompt', event.target.value)} /></label>
    <fieldset className="agent-tool-list"><legend>Allowed tools</legend>{groupTools(tools).map(([group, entries]) => <div className="agent-tool-group" key={group}><strong>{group}</strong>{entries.map((tool) => <SwitchFieldInput
      key={tool.id} checked={draft.toolIds.includes(tool.id)} label={tool.name}
      hint={tool.available ? tool.description : `${tool.description} Unavailable: ${tool.unavailableReason ?? 'provider missing'}`}
      disabled={!tool.available} onCheckedChange={(checked) => update('toolIds', checked ? [...draft.toolIds, tool.id] : draft.toolIds.filter((id) => id !== tool.id))}
    />)}</div>)}</fieldset>
    {error && <p className="settings-error" role="alert">{error}</p>}
    <div className="settings-actions"><button type="button" className="settings-save" onClick={() => void save(draft)}>Save agent</button><button type="button" className="settings-secondary" onClick={onCancel}>Cancel</button></div>
  </div>
}

function executorValue(executor: { extensionId: string; executorId: string }): string {
  return `${executor.extensionId}/${executor.executorId}`
}

function SkillForm({ initial, agents, tools, executors, onSave, onCancel }: {
  initial: SkillDraft; agents: AgentDefinition[]; tools: SelectorTool[]; executors: ExtensionExecutorOption[]
  onSave: (draft: SkillDraft) => Promise<void>; onCancel: () => void
}) {
  const [draft, setDraft] = useState(initial)
  const [configurationIssues, setConfigurationIssues] = useState<ConfigurationIssue[]>([])
  const { error, save } = useInlineSave(async (candidate: SkillDraft) => {
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
      return
    }
    await onSave(candidate)
  })
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
  return <div className="custom-tool-form agent-form" role="group" aria-label="Skill editor">
    <label>Slash command<input className="settings-monospace" aria-label="Slash command" value={draft.label} onChange={(event) => updateCommon('label', event.target.value)} /></label>
    <label>Description<input aria-label="Skill description" value={draft.description} onChange={(event) => updateCommon('description', event.target.value)} /></label>
    <label>Execution<select aria-label="Skill execution" value={draft.execution === 'extension' ? executorValue(draft.executor) : 'llm'} onChange={(event) => chooseExecution(event.target.value)}>
      <option value="llm">LLM agent</option>
      {executionOptions.map((executor) => <option key={executorValue(executor)} value={executorValue(executor)} disabled={!executor.available}>
        {executor.sourceName} · {executor.name}{executor.available ? '' : ' (unavailable)'}
      </option>)}
    </select></label>
    {draft.execution === 'extension' ? <>
      {selectedExecutor?.description && <p className="settings-hint">{selectedExecutor.description}</p>}
      {(selectedExecutor ?? retainedExecutor) && <ExtensionSkillConfigurationForm
        form={(selectedExecutor ?? retainedExecutor)!.configuration}
        configuration={draft.configuration}
        issues={configurationIssues}
        onChange={(configuration) => { setConfigurationIssues([]); setDraft((before) => before.execution === 'extension' ? { ...before, configuration } : before) }}
      />}
      {!selectedExecutor?.available && <p className="settings-error" role="alert">{selectedExecutor?.unavailableReason ?? retainedExecutor?.unavailableReason}</p>}
    </> : <>
      <label>Agent<select aria-label="Skill agent" value={draft.agentId} onChange={(event) => chooseAgent(event.target.value)}>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
      <label>Workflow instructions<textarea aria-label="Skill instructions" value={draft.systemPrompt} onChange={(event) => setDraft((before) => before.execution === 'extension' ? before : { ...before, systemPrompt: event.target.value })} /></label>
      <fieldset className="agent-tool-list"><legend>Required tools</legend>{agentTools.map((tool) => <SwitchFieldInput
      key={tool.id} checked={requiredToolIds.includes(tool.id)} label={tool.name} hint={tool.description} disabled={!tool.available}
      onCheckedChange={(checked) => setDraft((before) => before.execution === 'extension' ? before : { ...before, requiredToolIds: checked ? [...requiredToolIds, tool.id] : requiredToolIds.filter((id) => id !== tool.id) })}
      />)}</fieldset>
    </>}
    {error && <p className="settings-error" role="alert">{error}</p>}
    <div className="settings-actions"><button type="button" className="settings-save" onClick={() => void save(draft)}>Save skill</button><button type="button" className="settings-secondary" onClick={onCancel}>Cancel</button></div>
  </div>
}

function SkillRow({ skill, agentName, onEdit, onRemove }: {
  skill: SkillDefinition; agentName: string; onEdit?: () => void; onRemove: () => void
}) {
  return <div className="tool-setting"><span><strong>/{skill.label}</strong><small>{skill.description}</small><code>{agentName}</code></span><div className="tool-setting-actions">
    {onEdit && <button type="button" onClick={onEdit}>Edit</button>}
    <ConfirmButton label="Remove" confirmLabel="Confirm remove" ariaLabel={`Remove /${skill.label}`} confirmAriaLabel={`Confirm removing /${skill.label}`} onConfirm={onRemove} />
  </div></div>
}

export function AgentSettings({ extensionTools = [], extensionExecutors = [], reportError }: {
  extensionTools?: ExtensionToolOption[]; extensionExecutors?: ExtensionExecutorOption[]; reportError: (error: unknown) => void
}) {
  const agents = useSettingsStore((state) => state.agents)
  const skills = useSettingsStore((state) => state.skills)
  const customTools = useSettingsStore((state) => state.customTools)
  const saveAgent = useSettingsStore((state) => state.saveAgent)
  const removeAgent = useSettingsStore((state) => state.removeAgent)
  const saveSkill = useSettingsStore((state) => state.saveSkill)
  const removeSkill = useSettingsStore((state) => state.removeSkill)
  const reset = useSettingsStore((state) => state.resetAgentConfiguration)
  const [agentDraft, setAgentDraft] = useState<AgentDraft | null>(null)
  const [skillDraft, setSkillDraft] = useState<SkillDraft | null>(null)
  const [syncError, setSyncError] = useState<{ section: 'agents' | 'skills'; message: string } | null>(null)
  const agentsHeadingId = useId()
  const skillsHeadingId = useId()
  const knownTools: SelectorTool[] = [
    ...BUILTIN_TOOL_OPTIONS.map((tool) => ({ ...tool, group: 'Built-in', available: true })),
    ...customTools.map(({ id, name, description }) => ({ id, name, description, group: 'Custom HTTP', available: true })),
    ...extensionTools.map((tool) => ({ ...tool, group: `Extension · ${tool.sourceName}`, isExtension: true })),
  ]
  const knownIds = new Set(knownTools.map((tool) => tool.id))
  const retainedIds = [...new Set([
    ...agents.flatMap((agent) => agent.toolIds),
    ...skills.flatMap((skill) => isExtensionSkill(skill) ? [] : skill.requiredToolIds),
  ])].filter((id) => !knownIds.has(id))
  const tools: SelectorTool[] = [...knownTools, ...retainedIds.map((id) => ({ id, name: id, description: 'This configured tool provider is missing or unavailable.', group: 'Unavailable references', available: false }))]
  const publish = async (section: 'agents' | 'skills') => {
    setSyncError(null)
    try { await publishLocalAgentConfiguration() } catch (error) { setSyncError({ section, message: `Saved on this device, but not published to the server: ${errorMessage(error)}` }) }
  }
  const perform = async (action: () => Promise<void>, done?: () => void | Promise<void>) => {
    try { await action() } catch (error) { reportError(error); return }
    await done?.()
  }
  return <>
    <section className="settings-section" aria-labelledby={agentsHeadingId}><h2 id={agentsHeadingId}>Agents</h2><div className="tool-list">{agents.map((agent) => <div className="tool-setting" key={agent.id}><span><strong>{agent.name}</strong><small>{agent.description}</small><code>{agent.toolIds.length} tool(s)</code></span><div className="tool-setting-actions"><button type="button" onClick={() => setAgentDraft({ ...agent, toolIds: [...agent.toolIds] })}>Edit</button><ConfirmButton label="Remove" confirmLabel="Confirm remove" ariaLabel={`Remove ${agent.name}`} confirmAriaLabel={`Confirm removing ${agent.name}`} onConfirm={() => void perform(() => removeAgent(agent.id), () => publish('agents'))} /></div></div>)}</div>
      {syncError?.section === 'agents' && <p className="settings-error" role="alert">{syncError.message}</p>}
      {agentDraft ? <AgentForm initial={agentDraft} tools={tools} onSave={async (draft) => { await saveAgent(draft); setAgentDraft(null); await publish('agents') }} onCancel={() => setAgentDraft(null)} /> : <button type="button" className="settings-secondary add-tool" onClick={() => setAgentDraft({ ...EMPTY_AGENT, toolIds: tools.filter((tool) => tool.available && !tool.isExtension).map((tool) => tool.id) })}>+ Add agent</button>}
    </section>
    <section className="settings-section" aria-labelledby={skillsHeadingId}><h2 id={skillsHeadingId}>Skills</h2><p className="settings-hint">Choose an LLM agent or an installed extension executor. Extensions provide declarative fields but never install commands or skills.</p><div className="tool-list">{skills.map((skill) => <SkillRow
      key={skill.id} skill={skill}
      agentName={isExtensionSkill(skill) ? `Extension · ${skill.executor.extensionId}/${skill.executor.executorId}` : agents.find((agent) => agent.id === skill.agentId)?.name ?? 'Missing agent'}
      onEdit={() => setSkillDraft(isExtensionSkill(skill) ? { ...skill, configuration: structuredClone(skill.configuration) } : { ...skill })}
      onRemove={() => void perform(() => removeSkill(skill.id), () => publish('skills'))}
    />)}</div>
      {syncError?.section === 'skills' && <p className="settings-error" role="alert">{syncError.message}</p>}
      {skillDraft ? <SkillForm initial={skillDraft} agents={agents} tools={tools} executors={extensionExecutors} onSave={async (draft) => { await saveSkill(draft); setSkillDraft(null); await publish('skills') }} onCancel={() => setSkillDraft(null)} /> : <button type="button" className="settings-secondary add-tool" onClick={() => setSkillDraft({ label: '', description: '', execution: 'llm', systemPrompt: '', agentId: agents[0]?.id ?? '', requiredToolIds: [] })}>+ Add skill</button>}
      <ConfirmButton label="Restore built-in agents and skills" confirmLabel="Confirm restore built-ins" className="settings-secondary reset-agents" onConfirm={() => void perform(reset, () => publish('skills'))} />
    </section>
  </>
}

function groupTools(tools: SelectorTool[]): Array<[string, SelectorTool[]]> {
  const groups = new Map<string, SelectorTool[]>()
  for (const tool of tools) groups.set(tool.group, [...(groups.get(tool.group) ?? []), tool])
  return [...groups.entries()]
}
