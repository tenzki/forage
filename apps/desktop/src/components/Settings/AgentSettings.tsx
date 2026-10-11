import { Plus } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { isExtensionSkill, type AgentDraft, type SkillDraft, type SkillDefinition } from '../../agent/definitions'
import { publishLocalAgentConfiguration } from '../../agent/serverConfigurationSync'
import { useSettingsStore } from '../../store/settingsStore'
import type { ExtensionExecutorOption, ExtensionToolOption } from '../../store/extensionStore'
import { AgentForm, SkillForm } from './AgentEditors'
import { useEditorTools } from './useEditorTools'
import { usePublishedDraft } from './saveEditorDraft'
import { useSettingsNavigation } from './settingsNavigation'
import { ConfirmButton } from './ConfirmButton'
import { Button } from '../ui/Button'
import { ListRow } from '../ui/ListRow'

function SkillRow({ skill, agentName, onEdit, onRemove }: {
  skill: SkillDefinition; agentName: string; onEdit?: () => void; onRemove: () => void
}) {
  return <ListRow title={`/${skill.label}`} description={skill.description} meta={agentName} actions={<>
    {onEdit && <Button id={`edit-skill-${skill.id}`} size="sm" onClick={onEdit}>Edit</Button>}
    <ConfirmButton variant="danger" size="sm" label="Remove" confirmLabel="Confirm remove" ariaLabel={`Remove /${skill.label}`} confirmAriaLabel={`Confirm removing /${skill.label}`} onConfirm={onRemove} />
  </>} />
}

export function AgentSettings({ extensionTools = [], extensionExecutors = [], reportError }: {
  extensionTools?: ExtensionToolOption[]; extensionExecutors?: ExtensionExecutorOption[]; reportError: (error: unknown) => void
}) {
  const agents = useSettingsStore((state) => state.agents)
  const skills = useSettingsStore((state) => state.skills)
  const saveAgent = useSettingsStore((state) => state.saveAgent)
  const saveSkill = useSettingsStore((state) => state.saveSkill)
  const [agentDraft, setAgentDraft] = useState<AgentDraft | null>(null)
  const [skillDraft, setSkillDraft] = useState<SkillDraft | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const navigation = useSettingsNavigation()
  const { tools, connections, environment } = useEditorTools(extensionTools, [...(agentDraft?.toolIds ?? []), ...agents.flatMap((agent) => agent.toolIds)])
  const persistAgent = usePublishedDraft(saveAgent, agentDraft)
  const persistSkill = usePublishedDraft(saveSkill, skillDraft)
  const headingId = useId()
  const close = () => {
    setAgentDraft(null); setSkillDraft(null)
    if (navigation?.route.section === 'agents' && navigation.route.page) navigation.back()
  }
  const editAgent = (draft: AgentDraft) => {
    const action = () => { setSkillDraft(null); setAgentDraft(draft); navigation?.open('agents', 'agent', () => setAgentDraft(null), draft.id) }
    if (navigation) navigation.requestLeave(action); else action()
  }
  const editSkill = (draft: SkillDraft) => {
    const action = () => { setAgentDraft(null); setSkillDraft(draft); navigation?.open('agents', 'skill', () => setSkillDraft(null), draft.id) }
    if (navigation) navigation.requestLeave(action); else action()
  }
  useEffect(() => {
    const missing = agentDraft?.id && !agentDraft.id.startsWith('draft_') && !agents.some((agent) => agent.id === agentDraft.id)
      || skillDraft?.id && !skillDraft.id.startsWith('draft_') && !skills.some((skill) => skill.id === skillDraft.id)
    if (missing) { setAgentDraft(null); setSkillDraft(null); navigation?.clearGuard(); navigation?.back(); setMessage('This saved item is no longer available. Returned to Agents.') }
  }, [agents, skills, agentDraft, skillDraft, navigation])
  useEffect(() => {
    if (navigation?.route.section === 'agents' && navigation.route.page === 'agent' && navigation.route.entityId && !agentDraft) {
      const agent = agents.find((candidate) => candidate.id === navigation.route.entityId)
      if (agent) setAgentDraft({ ...agent, toolIds: [...agent.toolIds] })
      else { navigation.back(); setMessage('This saved item is no longer available. Returned to Agents.') }
    }
  }, [navigation, agents, agentDraft])
  const perform = async (operation: () => Promise<void>) => {
    try {
      await operation()
      try { await publishLocalAgentConfiguration() } catch { setMessage('Saved on this device, but not published to the server. Retry publication in Connection.') }
    } catch (error) { reportError(error) }
  }
  const executors = extensionExecutors.map((executor) => environment !== 'local' ? { ...executor, available: false, unavailableReason: 'Device-local extension executors require confirmed local execution.' } : executor)
  if (agentDraft) return <section className="settings-section settings-editor" aria-label="Agents"><div className="settings-heading-copy"><h2>Edit agent</h2><p className="settings-hint">{agentDraft.name || 'Create a named assistant with its own instructions and tools.'}</p></div><AgentForm key={agentDraft.id} initial={agentDraft} tools={tools} connections={connections} onSave={persistAgent} onCancel={close} /></section>
  if (skillDraft) return <section className="settings-section settings-editor" aria-label="Skills"><div className="settings-heading-copy"><h2>Edit skill</h2><p className="settings-hint">{skillDraft.label ? `/${skillDraft.label}` : 'Create a workflow using an agent or extension.'}</p></div><SkillForm key={skillDraft.id} initial={skillDraft} agents={agents} tools={tools} executors={executors} onSave={persistSkill} onCancel={close} /></section>
  return <>
    <section className="settings-section settings-group" aria-labelledby={headingId}><div className="settings-heading-copy"><h2 id={headingId}>Agents</h2><p className="settings-hint">Named assistants with their own instructions and allowed tools.</p></div>
      <div className="settings-row-list">{agents.map((agent) => <ListRow key={agent.id} title={agent.name} description={agent.description} meta={`${agent.toolIds.length} tool(s)`} actions={<>
        <Button id={`edit-agent-${agent.id}`} size="sm" onClick={() => editAgent({ ...agent, toolIds: [...agent.toolIds] })}>Edit</Button>
        <ConfirmButton variant="danger" size="sm" label="Remove" confirmLabel="Confirm remove" ariaLabel={`Remove ${agent.name}`} confirmAriaLabel={`Confirm removing ${agent.name}`} onConfirm={() => void perform(() => useSettingsStore.getState().removeAgent(agent.id))} />
      </>} />)}</div>
      <Button variant="add" icon={<Plus aria-hidden="true" />} onClick={() => editAgent({ id: `draft_${crypto.randomUUID()}`, name: '', description: '', systemPrompt: '', toolIds: [] })}>Add agent</Button>
    </section>
    <section className="settings-section settings-group" aria-label="Skills"><div className="settings-heading-copy"><h2>Skills</h2>
      <p className="settings-hint">Workflows using an agent or extension. Extensions never install skills automatically.</p></div>
      <div className="settings-row-list">{skills.map((skill) => <SkillRow key={skill.id} skill={skill} agentName={isExtensionSkill(skill) ? `Extension · ${skill.executor.extensionId}/${skill.executor.executorId}` : agents.find((agent) => agent.id === skill.agentId)?.name ?? 'Missing agent'} onEdit={() => editSkill(isExtensionSkill(skill) ? { ...skill, configuration: structuredClone(skill.configuration) } : { ...skill })} onRemove={() => void perform(() => useSettingsStore.getState().removeSkill(skill.id))} />)}</div>
      <div className="settings-actions">
      <Button variant="add" icon={<Plus aria-hidden="true" />} onClick={() => editSkill({ id: `draft_${crypto.randomUUID()}`, label: '', description: '', execution: 'llm', systemPrompt: '', agentId: agents[0]?.id ?? '', requiredToolIds: [] })}>Add skill</Button>
      <ConfirmButton label="Restore built-in agents and skills" confirmLabel="Confirm restore built-ins" onConfirm={() => void perform(useSettingsStore.getState().resetAgentConfiguration)} />
      </div>
    </section>
    {message && <p role="alert" className="settings-error">{message}</p>}
  </>
}
