import { useId, useState } from 'react'
import {
  type AgentDefinition,
  type AgentDraft,
  type SkillDefinition,
  type SkillDraft,
} from '../../agent/definitions'
import { publishLocalAgentConfiguration } from '../../agent/serverConfigurationSync'
import { BUILTIN_TOOL_OPTIONS, type ToolOption } from '../../agent/tools'
import { useSettingsStore } from '../../store/settingsStore'
import { SwitchFieldInput } from '../ui/SwitchFieldInput'
import { ConfirmButton } from './ConfirmButton'

const EMPTY_AGENT: AgentDraft = {
  name: '', description: '', systemPrompt: '', toolIds: [],
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function useInlineSave<T>(onSave: (draft: T) => Promise<void>) {
  const [error, setError] = useState<string | null>(null)
  const save = async (draft: T) => {
    setError(null)
    try {
      await onSave(draft)
    } catch (saveError) {
      setError(errorMessage(saveError))
    }
  }
  return { error, save }
}

function AgentForm({ initial, tools, onSave, onCancel }: {
  initial: AgentDraft
  tools: ToolOption[]
  onSave: (draft: AgentDraft) => Promise<void>
  onCancel: () => void
}) {
  const [draft, setDraft] = useState<AgentDraft>(initial)
  const { error, save } = useInlineSave(onSave)
  const update = <K extends keyof AgentDraft>(key: K, value: AgentDraft[K]) => {
    setDraft((valueBefore) => ({ ...valueBefore, [key]: value }))
  }

  return (
    <div className="custom-tool-form agent-form" role="group" aria-label="Agent editor">
      <label>Agent name<input aria-label="Agent name" value={draft.name} onChange={(event) => update('name', event.target.value)} /></label>
      <label>Description<input aria-label="Agent description" value={draft.description} onChange={(event) => update('description', event.target.value)} /></label>
      <label>Instructions<textarea aria-label="Agent instructions" value={draft.systemPrompt} onChange={(event) => update('systemPrompt', event.target.value)} /></label>
      <fieldset className="agent-tool-list"><legend>Allowed tools</legend>
        {tools.map((tool) => (
          <SwitchFieldInput
            key={tool.id}
            checked={draft.toolIds.includes(tool.id)}
            label={tool.name}
            hint={tool.description}
            onCheckedChange={(checked) => update('toolIds', checked
                ? [...draft.toolIds, tool.id]
                : draft.toolIds.filter((id) => id !== tool.id))}
          />
        ))}
      </fieldset>
      {error && <p className="settings-error" role="alert">{error}</p>}
      <div className="settings-actions">
        <button type="button" className="settings-save" onClick={() => void save(draft)}>Save agent</button>
        <button type="button" className="settings-secondary" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

function SkillForm({ initial, agents, tools, onSave, onCancel }: {
  initial: SkillDraft
  agents: AgentDefinition[]
  tools: ToolOption[]
  onSave: (draft: SkillDraft) => Promise<void>
  onCancel: () => void
}) {
  const [draft, setDraft] = useState<SkillDraft>(initial)
  const { error, save } = useInlineSave(onSave)
  const update = <K extends keyof SkillDraft>(key: K, value: SkillDraft[K]) => {
    setDraft((valueBefore) => ({ ...valueBefore, [key]: value }))
  }
  const requiredToolIds = draft.requiredToolIds ?? []
  const agentToolIds = agents.find((agent) => agent.id === draft.agentId)?.toolIds ?? []
  const agentTools = tools.filter((tool) => agentToolIds.includes(tool.id))
  const chooseAgent = (agentId: string) => {
    const allowed = agents.find((agent) => agent.id === agentId)?.toolIds ?? []
    setDraft((valueBefore) => ({
      ...valueBefore,
      agentId,
      requiredToolIds: (valueBefore.requiredToolIds ?? []).filter((id) => allowed.includes(id)),
    }))
  }

  return (
    <div className="custom-tool-form agent-form" role="group" aria-label="Skill editor">
      <label>Slash command<input className="settings-monospace" aria-label="Slash command" value={draft.label} onChange={(event) => update('label', event.target.value)} placeholder="summarize" /></label>
      <label>Description<input aria-label="Skill description" value={draft.description} onChange={(event) => update('description', event.target.value)} /></label>
      <label>Agent<select aria-label="Skill agent" value={draft.agentId} onChange={(event) => chooseAgent(event.target.value)}>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
      <label>Workflow instructions<textarea aria-label="Skill instructions" value={draft.systemPrompt} onChange={(event) => update('systemPrompt', event.target.value)} /></label>
      <fieldset className="agent-tool-list"><legend>Required tools</legend>
        <p className="settings-hint">The skill runs only when these tools are available. Choose from the tools its agent allows; edit the agent to allow more.</p>
        {agentTools.map((tool) => (
          <SwitchFieldInput
            key={tool.id}
            checked={requiredToolIds.includes(tool.id)}
            label={tool.name}
            hint={tool.description}
            onCheckedChange={(checked) => update('requiredToolIds', checked
                ? [...requiredToolIds, tool.id]
                : requiredToolIds.filter((id) => id !== tool.id))}
          />
        ))}
      </fieldset>
      {error && <p className="settings-error" role="alert">{error}</p>}
      <div className="settings-actions">
        <button type="button" className="settings-save" onClick={() => void save(draft)}>Save skill</button>
        <button type="button" className="settings-secondary" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

function AgentRow({ agent, onEdit, onRemove }: {
  agent: AgentDefinition
  onEdit: () => void
  onRemove: () => void
}) {
  return (
    <div className="tool-setting">
      <span>
        <strong>{agent.name}</strong>
        <small>{agent.description}</small>
        <code>{agent.toolIds.length ? `${agent.toolIds.length} tool(s)` : 'No tools'} · Uses active Compute model</code>
      </span>
      <div className="tool-setting-actions">
        <button type="button" onClick={onEdit}>Edit</button>
        <ConfirmButton
          label="Remove"
          confirmLabel="Confirm remove"
          ariaLabel={`Remove ${agent.name}`}
          confirmAriaLabel={`Confirm removing ${agent.name}`}
          onConfirm={onRemove}
        />
      </div>
    </div>
  )
}

function SkillRow({ skill, agentName, onEdit, onRemove }: {
  skill: SkillDefinition
  agentName: string
  onEdit: () => void
  onRemove: () => void
}) {
  return (
    <div className="tool-setting">
      <span><strong>/{skill.label}</strong><small>{skill.description}</small><code>{agentName}</code></span>
      <div className="tool-setting-actions">
        <button type="button" onClick={onEdit}>Edit</button>
        <ConfirmButton
          label="Remove"
          confirmLabel="Confirm remove"
          ariaLabel={`Remove /${skill.label}`}
          confirmAriaLabel={`Confirm removing /${skill.label}`}
          onConfirm={onRemove}
        />
      </div>
    </div>
  )
}

export function AgentSettings({ reportError }: { reportError: (error: unknown) => void }) {
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
  const tools = [...BUILTIN_TOOL_OPTIONS, ...customTools.map(({ id, name, description }) => ({ id, name, description }))]

  // In server mode, Inbox automation only sees published skills, so every local change is published right away.
  const publish = async (section: 'agents' | 'skills') => {
    setSyncError(null)
    try {
      await publishLocalAgentConfiguration()
    } catch (error) {
      setSyncError({ section, message: `Saved on this device, but not published to the server: ${errorMessage(error)}` })
    }
  }

  const perform = async (action: () => Promise<void>, done?: () => void | Promise<void>) => {
    try {
      await action()
    } catch (error) {
      reportError(error)
      return
    }
    await done?.()
  }

  const syncAlert = (section: 'agents' | 'skills') => syncError?.section === section
    ? <p className="settings-error" role="alert">{syncError.message}</p>
    : null

  return (
    <>
      <section className="settings-section" aria-labelledby={agentsHeadingId}>
        <h2 id={agentsHeadingId}>Agents</h2>
        <p className="settings-hint">Agents define behavior, model selection, and the maximum tools their skills may use.</p>
        <div className="tool-list">
          {agents.map((agent) => (
            <AgentRow
              key={agent.id}
              agent={agent}
              onEdit={() => setAgentDraft({ ...agent, toolIds: [...agent.toolIds] })}
              onRemove={() => void perform(() => removeAgent(agent.id), () => publish('agents'))}
            />
          ))}
        </div>
        {syncAlert('agents')}
        {agentDraft ? (
          <AgentForm
            key={agentDraft.id ?? 'new'}
            initial={agentDraft}
            tools={tools}
            onSave={async (draft) => { await saveAgent(draft); setAgentDraft(null); await publish('agents') }}
            onCancel={() => setAgentDraft(null)}
          />
        ) : (
          <button type="button" className="settings-secondary add-tool" onClick={() => setAgentDraft({ ...EMPTY_AGENT, toolIds: tools.map((tool) => tool.id) })}>+ Add agent</button>
        )}
      </section>

      <section className="settings-section" aria-labelledby={skillsHeadingId}>
        <h2 id={skillsHeadingId}>Skills</h2>
        <p className="settings-hint">Skills become slash commands and run through their assigned agent.</p>
        <div className="tool-list">
          {skills.map((skill) => (
            <SkillRow
              key={skill.id}
              skill={skill}
              agentName={agents.find((agent) => agent.id === skill.agentId)?.name ?? 'Missing agent'}
              onEdit={() => setSkillDraft({ ...skill })}
              onRemove={() => void perform(() => removeSkill(skill.id), () => publish('skills'))}
            />
          ))}
        </div>
        {syncAlert('skills')}
        {skillDraft ? (
          <SkillForm
            key={skillDraft.id ?? 'new'}
            initial={skillDraft}
            agents={agents}
            tools={tools}
            onSave={async (draft) => { await saveSkill(draft); setSkillDraft(null); await publish('skills') }}
            onCancel={() => setSkillDraft(null)}
          />
        ) : (
          <button type="button" className="settings-secondary add-tool" onClick={() => setSkillDraft({ label: '', description: '', systemPrompt: '', agentId: agents[0]?.id ?? '' })}>+ Add skill</button>
        )}
        <ConfirmButton
          label="Restore built-in agents and skills"
          confirmLabel="Confirm restore built-ins"
          className="settings-secondary reset-agents"
          onConfirm={() => void perform(reset, () => publish('skills'))}
        />
      </section>
    </>
  )
}
