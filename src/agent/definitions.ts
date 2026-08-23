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

export type ContextAnchor = 'invocation' | 'parent' | 'previousSibling'
export type ContextPreset =
  | 'current'
  | 'lineage'
  | 'current-branch'
  | 'parent-branch'
  | 'previous-branch'
  | 'current-level'
  | 'neighboring-branches'
  | 'custom'

export type ContextSelector =
  | { kind: 'self' }
  | { kind: 'ancestors'; maxDepth?: number }
  | { kind: 'descendants'; maxDepth?: number }
  | {
      kind: 'siblings'
      position: 'before' | 'after' | 'both'
      includeSubtrees: boolean
      maxDepth?: number
    }

export interface SkillContextStrategy {
  preset: ContextPreset
  anchor: ContextAnchor
  selectors: ContextSelector[]
  filters: {
    excludeInvocation: boolean
    includeAiNodes: boolean
    includeEmptyNodes: boolean
  }
  budget: {
    maxNodes: number
    maxCharacters: number
    overflow: 'block' | 'truncate'
  }
}

export interface SkillDefinition {
  id: string
  /** Slash trigger without the leading slash. */
  label: string
  description: string
  systemPrompt: string
  agentId: string
  contextStrategy: SkillContextStrategy
}

export type AgentDraft = Omit<AgentDefinition, 'id'> & { id?: string }
export type SkillDraft = Omit<SkillDefinition, 'id' | 'contextStrategy'> & {
  id?: string
  /** Optional only so persisted pre-context skills can migrate safely. */
  contextStrategy?: SkillContextStrategy
}

export const DEFAULT_AGENT_ID = 'general-agent'

const DEFAULT_FILTERS: SkillContextStrategy['filters'] = {
  excludeInvocation: false,
  includeAiNodes: true,
  includeEmptyNodes: false,
}
const DEFAULT_BUDGET: SkillContextStrategy['budget'] = {
  maxNodes: 100,
  maxCharacters: 40_000,
  overflow: 'truncate',
}

export const CONTEXT_PRESET_OPTIONS: Array<{ id: Exclude<ContextPreset, 'custom'>; name: string }> = [
  { id: 'current', name: 'Current node' },
  { id: 'lineage', name: 'Path to current node' },
  { id: 'current-branch', name: 'Current branch' },
  { id: 'parent-branch', name: 'Parent branch' },
  { id: 'previous-branch', name: 'Previous branch' },
  { id: 'current-level', name: 'Current level' },
  { id: 'neighboring-branches', name: 'Neighboring branches' },
]

export function contextStrategyForPreset(preset: Exclude<ContextPreset, 'custom'>): SkillContextStrategy {
  const strategy: SkillContextStrategy = {
    preset,
    anchor: 'invocation',
    selectors: [{ kind: 'self' }],
    filters: { ...DEFAULT_FILTERS },
    budget: { ...DEFAULT_BUDGET },
  }
  if (preset === 'lineage') strategy.selectors.push({ kind: 'ancestors' })
  if (preset === 'current-branch') strategy.selectors.push({ kind: 'descendants' })
  if (preset === 'parent-branch') {
    strategy.anchor = 'parent'
    strategy.selectors.push({ kind: 'descendants' })
    strategy.filters.excludeInvocation = true
  }
  if (preset === 'previous-branch') {
    strategy.anchor = 'previousSibling'
    strategy.selectors.push({ kind: 'descendants' })
    strategy.filters.excludeInvocation = true
  }
  if (preset === 'current-level' || preset === 'neighboring-branches') {
    if (preset === 'neighboring-branches') strategy.selectors.push({ kind: 'descendants' })
    strategy.selectors.push({
      kind: 'siblings',
      position: 'both',
      includeSubtrees: preset === 'neighboring-branches',
    })
  }
  return strategy
}

export const DEFAULT_AGENTS: AgentDefinition[] = [{
  id: DEFAULT_AGENT_ID,
  name: 'General assistant',
  description: 'General-purpose outline assistant',
  systemPrompt: 'You are an agent embedded in a tree-based note-taking application. Be concise, factual, and organize the answer for an outliner.',
  modelId: '',
  toolIds: ['web_search', 'web_fetch', 'generate_image'],
}]

const DEFAULT_CONTEXT = contextStrategyForPreset('lineage')
export const DEFAULT_SKILLS: SkillDefinition[] = [
  {
    id: 'research', label: 'research', description: 'Investigate a topic and structure findings as notes',
    agentId: DEFAULT_AGENT_ID, contextStrategy: DEFAULT_CONTEXT,
    systemPrompt: 'Investigate the topic using the selected outline context. Use web_search for current or externally verifiable facts and web_fetch to verify useful sources. Include source URLs.',
  },
  {
    id: 'brainstorm', label: 'brainstorm', description: 'Generate ideas and options for the current note',
    agentId: DEFAULT_AGENT_ID, contextStrategy: DEFAULT_CONTEXT,
    systemPrompt: 'Generate a varied set of concise ideas or options using the selected outline context.',
  },
  {
    id: 'ask', label: 'ask', description: 'Ask the agent a question about this branch',
    agentId: DEFAULT_AGENT_ID, contextStrategy: DEFAULT_CONTEXT,
    systemPrompt: 'Answer the question using the selected outline context. Be concise and direct.',
  },
  {
    id: 'image', label: 'image', description: 'Generate an image under the current note',
    agentId: DEFAULT_AGENT_ID, contextStrategy: DEFAULT_CONTEXT,
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

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isInteger(value)
    ? Math.min(max, Math.max(min, value))
    : fallback
}

function validateSelector(value: unknown): ContextSelector | null {
  if (!value || typeof value !== 'object') return null
  const selector = value as Partial<ContextSelector> & { maxDepth?: unknown }
  const maxDepth = selector.maxDepth === undefined
    ? undefined
    : boundedInteger(selector.maxDepth, 1, 1, 20)
  if (selector.kind === 'self') return { kind: 'self' }
  if (selector.kind === 'ancestors' || selector.kind === 'descendants') {
    return { kind: selector.kind, ...(maxDepth ? { maxDepth } : {}) }
  }
  if (selector.kind !== 'siblings') return null
  const position = ['before', 'after', 'both'].includes(String(selector.position))
    ? selector.position as 'before' | 'after' | 'both'
    : 'both'
  return {
    kind: 'siblings', position, includeSubtrees: selector.includeSubtrees === true,
    ...(maxDepth ? { maxDepth } : {}),
  }
}

export function validateContextStrategy(value: unknown): SkillContextStrategy {
  if (!value || typeof value !== 'object') return contextStrategyForPreset('lineage')
  const candidate = value as Partial<SkillContextStrategy>
  const preset = [...CONTEXT_PRESET_OPTIONS.map((option) => option.id), 'custom'].includes(String(candidate.preset))
    ? candidate.preset as ContextPreset
    : 'custom'
  const anchor = ['invocation', 'parent', 'previousSibling'].includes(String(candidate.anchor))
    ? candidate.anchor as ContextAnchor
    : 'invocation'
  const selectors = Array.isArray(candidate.selectors)
    ? candidate.selectors.map(validateSelector).filter((selector): selector is ContextSelector => Boolean(selector))
    : []
  const filters = candidate.filters as Partial<SkillContextStrategy['filters']> | undefined
  const budget = candidate.budget as Partial<SkillContextStrategy['budget']> | undefined
  return {
    preset,
    anchor,
    selectors: selectors.length ? selectors : [{ kind: 'self' }],
    filters: {
      excludeInvocation: filters?.excludeInvocation === true,
      includeAiNodes: filters?.includeAiNodes !== false,
      includeEmptyNodes: filters?.includeEmptyNodes === true,
    },
    budget: {
      maxNodes: boundedInteger(budget?.maxNodes, DEFAULT_BUDGET.maxNodes, 1, 500),
      maxCharacters: boundedInteger(budget?.maxCharacters, DEFAULT_BUDGET.maxCharacters, 100, 200_000),
      overflow: budget?.overflow === 'block' ? 'block' : 'truncate',
    },
  }
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
    contextStrategy: validateContextStrategy(draft.contextStrategy),
  }
}

export function cloneContextStrategy(strategy: SkillContextStrategy): SkillContextStrategy {
  return {
    ...strategy,
    selectors: strategy.selectors.map((selector) => ({ ...selector })),
    filters: { ...strategy.filters },
    budget: { ...strategy.budget },
  }
}

export function copyDefaultAgents(): AgentDefinition[] {
  return DEFAULT_AGENTS.map((agent) => ({ ...agent, toolIds: [...agent.toolIds] }))
}

export function copyDefaultSkills(): SkillDefinition[] {
  return DEFAULT_SKILLS.map((skill) => ({ ...skill, contextStrategy: cloneContextStrategy(skill.contextStrategy) }))
}
