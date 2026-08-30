import type { ToolOption } from './tools'

export interface AgentDefinition {
  id: string
  name: string
  description: string
  systemPrompt: string
  /** Empty means inherit the model selected under Codex settings. */
  modelId: string
  /** Tool ids this agent may use, further restricted by globally enabled tools. */
  toolIds: string[]
}

export interface SkillDefinition {
  id: string
  /** Slash trigger without the leading slash. */
  label: string
  description: string
  systemPrompt: string
  agentId: string
}

export type AgentDraft = Omit<AgentDefinition, 'id'> & { id?: string }
export type SkillDraft = Omit<SkillDefinition, 'id'> & {
  id?: string
  /** Accepted only so older persisted skills can be loaded and cleaned safely. */
  contextStrategy?: unknown
}

export const DEFAULT_AGENT_ID = 'general-agent'

export const DEFAULT_AGENTS: AgentDefinition[] = [{
  id: DEFAULT_AGENT_ID,
  name: 'General assistant',
  description: 'General-purpose outline assistant',
  systemPrompt: 'You are an agent embedded in a tree-based note-taking application. Be concise, factual, and organize the answer for an outliner.',
  modelId: '',
  toolIds: ['web_search', 'web_fetch', 'generate_image'],
}]

export const DEFAULT_SKILLS: SkillDefinition[] = [
  {
    id: 'research', label: 'research', description: 'Investigate a topic and structure findings as notes',
    agentId: DEFAULT_AGENT_ID,
    systemPrompt: 'Investigate the topic using the selected outline context. Use web_search for current or externally verifiable facts and web_fetch to verify useful sources. Include source URLs.',
  },
  {
    id: 'brainstorm', label: 'brainstorm', description: 'Generate ideas and options for the current note',
    agentId: DEFAULT_AGENT_ID,
    systemPrompt: 'Generate a varied set of concise ideas or options using the selected outline context.',
  },
  {
    id: 'ask', label: 'ask', description: 'Ask the agent a question about this branch',
    agentId: DEFAULT_AGENT_ID,
    systemPrompt: 'Answer the question using the selected outline context. Be concise and direct.',
  },
  {
    id: 'image', label: 'image', description: 'Generate an image under the current note',
    agentId: DEFAULT_AGENT_ID,
    systemPrompt: 'Call generate_image once for the requested visual. In emit_outline, return an optional caption as a text node followed by a separate image-only node containing the returned imageId and accessible imageAlt. Never attach an image to a text node.',
  },
]

function cleanText(value: string, label: string, maxLength: number): string {
  const result = value.trim()
  if (!result) throw new Error(`${label} is required.`)
  if (result.length > maxLength) throw new Error(`${label} must be at most ${maxLength} characters.`)
  return result
}

function validId(value: string | undefined): string {
  if (value && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value)) return value
  return crypto.randomUUID()
}

export function validateAgentDraft(draft: AgentDraft, availableTools: ToolOption[]): AgentDefinition {
  const allowedTools = new Set(availableTools.map((tool) => tool.id))
  const modelId = draft.modelId.trim()
  if (modelId && !/^[A-Za-z0-9._:/-]{1,128}$/.test(modelId)) throw new Error('Agent model is invalid.')
  return {
    id: validId(draft.id),
    name: cleanText(draft.name, 'Agent name', 80),
    description: cleanText(draft.description, 'Agent description', 300),
    systemPrompt: cleanText(draft.systemPrompt, 'Agent instructions', 20_000),
    modelId,
    toolIds: [...new Set(draft.toolIds.filter((id) => allowedTools.has(id)))],
  }
}

export function validateSkillDraft(draft: SkillDraft, agents: AgentDefinition[]): SkillDefinition {
  const label = draft.label.trim().toLowerCase()
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(label)) {
    throw new Error('Slash commands must use 2–32 lowercase letters, numbers, or hyphens.')
  }
  if (!agents.some((agent) => agent.id === draft.agentId)) throw new Error('Choose an agent for this skill.')
  return {
    id: validId(draft.id),
    label,
    description: cleanText(draft.description, 'Skill description', 300),
    systemPrompt: cleanText(draft.systemPrompt, 'Skill instructions', 20_000),
    agentId: draft.agentId,
  }
}

export function copyDefaultAgents(): AgentDefinition[] {
  return DEFAULT_AGENTS.map((agent) => ({ ...agent, toolIds: [...agent.toolIds] }))
}

export function copyDefaultSkills(): SkillDefinition[] {
  return DEFAULT_SKILLS.map((skill) => ({ ...skill }))
}
