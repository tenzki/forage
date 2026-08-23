import { useMemo, useState } from 'react'
import { codexModelOptions } from '../../agent/client'
import {
  type AgentDefinition,
  type AgentDraft,
  type SkillDefinition,
  type SkillDraft,
} from '../../agent/definitions'
import { BUILTIN_TOOL_OPTIONS, type ToolOption } from '../../agent/tools'
import { useSettingsStore } from '../../store/settingsStore'
import { ConfirmButton } from './ConfirmButton'

const EMPTY_AGENT: AgentDraft = {
  name: '', description: '', systemPrompt: '', modelId: '', toolIds: [],
}

function AgentForm({ initial, tools, onSave, onCancel }: {
  initial: AgentDraft
  tools: ToolOption[]
  onSave: (draft: AgentDraft) => void
  onCancel: () => void
}) {
  const authMode = useSettingsStore((state) => state.authMode)
  const [draft, setDraft] = useState<AgentDraft>(initial)
  const models = useMemo(() => codexModelOptions(authMode), [authMode])
  const update = <K extends keyof AgentDraft>(key: K, value: AgentDraft[K]) => {
    setDraft((valueBefore) => ({ ...valueBefore, [key]: value }))
  }

  return (
    <div className="custom-tool-form agent-form">
      <label>Agent name<input aria-label="Agent name" value={draft.name} onChange={(event) => update('name', event.target.value)} /></label>
      <label>Description<input aria-label="Agent description" value={draft.description} onChange={(event) => update('description', event.target.value)} /></label>
      <label>Instructions<textarea aria-label="Agent instructions" value={draft.systemPrompt} onChange={(event) => update('systemPrompt', event.target.value)} /></label>
      <label>Model
        <select aria-label="Agent model" value={draft.modelId} onChange={(event) => update('modelId', event.target.value)}>
          <option value="">Inherit global model</option>
          {models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
        </select>
      </label>
      <fieldset className="agent-tool-list"><legend>Allowed tools</legend>
        {tools.map((tool) => (
          <label key={tool.id}>
            <input
              type="checkbox"
              checked={draft.toolIds.includes(tool.id)}
              onChange={(event) => update('toolIds', event.target.checked
                ? [...draft.toolIds, tool.id]
                : draft.toolIds.filter((id) => id !== tool.id))}
            />
            {tool.name}
          </label>
        ))}
      </fieldset>
      <div className="settings-actions">
        <button type="button" className="settings-save" onClick={() => onSave(draft)}>Save agent</button>
        <button type="button" className="settings-secondary" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  )
}

function SkillForm({ initial, agents, onSave, onCancel }: {
  initial: SkillDraft
  agents: AgentDefinition[]
  onSave: (draft: SkillDraft) => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState<SkillDraft>(initial)
  const update = <K extends keyof SkillDraft>(key: K, value: SkillDraft[K]) => {
    setDraft((valueBefore) => ({ ...valueBefore, [key]: value }))
  }

  return (
    <div className="custom-tool-form agent-form">
      <label>Slash command<input className="settings-monospace" aria-label="Slash command" value={draft.label} onChange={(event) => update('label', event.target.value)} placeholder="summarize" /></label>
      <label>Description<input aria-label="Skill description" value={draft.description} onChange={(event) => update('description', event.target.value)} /></label>
      <label>Agent<select aria-label="Skill agent" value={draft.agentId} onChange={(event) => update('agentId', event.target.value)}>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
      <label>Workflow instructions<textarea aria-label="Skill instructions" value={draft.systemPrompt} onChange={(event) => update('systemPrompt', event.target.value)} /></label>
      <div className="settings-actions">
        <button type="button" className="settings-save" onClick={() => onSave(draft)}>Save skill</button>
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
        <code>{agent.modelId || 'Global model'} · {agent.toolIds.length ? `${agent.toolIds.length} tool(s)` : 'No tools'}</code>
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
  const tools = [...BUILTIN_TOOL_OPTIONS, ...customTools.map(({ id, name, description }) => ({ id, name, description }))]

  const perform = async (action: () => Promise<void>, done?: () => void) => {
    try {
      await action()
      done?.()
    } catch (error) {
      reportError(error)
    }
  }

  return (
    <>
      <section className="settings-section">
        <h2>Agents</h2>
        <p className="settings-hint">Agents define behavior, model selection, and the maximum tools their skills may use.</p>
        <div className="tool-list">
          {agents.map((agent) => (
            <AgentRow
              key={agent.id}
              agent={agent}
              onEdit={() => setAgentDraft({ ...agent, toolIds: [...agent.toolIds] })}
              onRemove={() => void perform(() => removeAgent(agent.id))}
            />
          ))}
        </div>
        {agentDraft ? (
          <AgentForm
            key={agentDraft.id ?? 'new'}
            initial={agentDraft}
            tools={tools}
            onSave={(draft) => void perform(() => saveAgent(draft), () => setAgentDraft(null))}
            onCancel={() => setAgentDraft(null)}
          />
        ) : (
          <button type="button" className="settings-secondary add-tool" onClick={() => setAgentDraft({ ...EMPTY_AGENT, toolIds: tools.map((tool) => tool.id) })}>+ Add agent</button>
        )}
      </section>

      <section className="settings-section">
        <h2>Skills</h2>
        <p className="settings-hint">Skills become slash commands and run through their assigned agent.</p>
        <div className="tool-list">
          {skills.map((skill) => (
            <SkillRow
              key={skill.id}
              skill={skill}
              agentName={agents.find((agent) => agent.id === skill.agentId)?.name ?? 'Missing agent'}
              onEdit={() => setSkillDraft({ ...skill })}
              onRemove={() => void perform(() => removeSkill(skill.id))}
            />
          ))}
        </div>
        {skillDraft ? (
          <SkillForm
            key={skillDraft.id ?? 'new'}
            initial={skillDraft}
            agents={agents}
            onSave={(draft) => void perform(() => saveSkill(draft), () => setSkillDraft(null))}
            onCancel={() => setSkillDraft(null)}
          />
        ) : (
          <button type="button" className="settings-secondary add-tool" onClick={() => setSkillDraft({ label: '', description: '', systemPrompt: '', agentId: agents[0]?.id ?? '' })}>+ Add skill</button>
        )}
        <ConfirmButton
          label="Restore built-in agents and skills"
          confirmLabel="Confirm restore built-ins"
          className="settings-secondary reset-agents"
          onConfirm={() => void perform(reset)}
        />
      </section>
    </>
  )
}
