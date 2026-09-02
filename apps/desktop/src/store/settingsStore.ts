import { create } from 'zustand'
import { load, type Store } from '@tauri-apps/plugin-store'
import type { CodexOAuthCredential } from '../agent/codexAuth'
import {
  LOCAL_CODEX_CREDENTIAL_ID,
  LOCAL_OPENAI_CREDENTIAL_ID,
  migrateLegacyCredentials,
  nativeLocalCredentialVault,
  type LocalCredentialMetadata,
} from '../agent/localCredentials'
import {
  copyDefaultAgents,
  copyDefaultSkills,
  DEFAULT_AGENT_ID,
  validateAgentDraft,
  validateSkillDraft,
  type AgentDefinition,
  type AgentDraft,
  type SkillDefinition,
  type SkillDraft,
} from '../agent/definitions'
import {
  BUILTIN_TOOL_OPTIONS,
  validateCustomToolDraft,
  type CustomHttpToolConfig,
  type CustomHttpToolDraft,
  type ToolOption,
} from '../agent/tools'

const STORE_FILE = 'settings.json'
const AUTH_MODE_FIELD = 'codexAuthMode'
const API_KEY_FIELD = 'openAiApiKey'
const OAUTH_FIELD = 'codexOAuthCredential'
const LOCAL_CREDENTIALS_FIELD = 'localModelCredentials'
const MODEL_FIELD = 'codexModelId'
const ENABLED_TOOLS_FIELD = 'enabledTools'
const CUSTOM_TOOLS_FIELD = 'customHttpTools'
const AGENTS_FIELD = 'agentDefinitions'
const SKILLS_FIELD = 'skillDefinitions'
const LEGACY_ANTHROPIC_FIELD = 'anthropicApiKey'

// Image generation consumes additional Codex/API limits and remains opt-in globally.
const DEFAULT_ENABLED_TOOLS = ['web_search', 'web_fetch']

export type CodexAuthMode = 'subscription' | 'api_key'

let storePromise: Promise<Store> | null = null
function getStore(): Promise<Store> {
  return (storePromise ??= load(STORE_FILE, { autoSave: true }))
}

async function saveField<T>(field: string, value: T): Promise<void> {
  const store = await getStore()
  await store.set(field, value)
  await store.save()
}

interface SettingsState {
  authMode: CodexAuthMode
  localCredentials: LocalCredentialMetadata[]
  modelId: string
  enabledToolIds: string[]
  customTools: CustomHttpToolConfig[]
  agents: AgentDefinition[]
  skills: SkillDefinition[]
  isLoaded: boolean
  error: string | null
  load: () => Promise<void>
  setAuthMode: (mode: CodexAuthMode) => Promise<void>
  setOpenAiApiKey: (key: string) => Promise<void>
  setOAuthCredential: (credential: CodexOAuthCredential | null) => Promise<void>
  setModelId: (modelId: string) => Promise<void>
  setToolEnabled: (toolId: string, enabled: boolean) => Promise<void>
  addCustomTool: (draft: CustomHttpToolDraft) => Promise<void>
  removeCustomTool: (toolId: string) => Promise<void>
  saveAgent: (draft: AgentDraft) => Promise<void>
  removeAgent: (agentId: string) => Promise<void>
  saveSkill: (draft: SkillDraft) => Promise<void>
  removeSkill: (skillId: string) => Promise<void>
  resetAgentConfiguration: () => Promise<void>
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function toolOptions(customTools: CustomHttpToolConfig[]): ToolOption[] {
  return [...BUILTIN_TOOL_OPTIONS, ...customTools.map(({ id, name, description }) => ({ id, name, description }))]
}

function validCustomTools(value: unknown): CustomHttpToolConfig[] {
  if (!Array.isArray(value)) return []
  const names = new Set<string>()
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return []
    const tool = candidate as Partial<CustomHttpToolConfig>
    if (typeof tool.id !== 'string') return []
    try {
      const valid = validateCustomToolDraft({
        name: tool.name ?? '',
        description: tool.description ?? '',
        urlTemplate: tool.urlTemplate ?? '',
      })
      if (names.has(valid.name)) return []
      names.add(valid.name)
      return [{ ...valid, id: tool.id }]
    } catch (error) {
      console.warn('[settings] ignored invalid custom tool:', error)
      return []
    }
  })
}

function validAgents(value: unknown, tools: ToolOption[]): AgentDefinition[] {
  if (!Array.isArray(value)) return copyDefaultAgents()
  const agents = value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return []
    try {
      return [validateAgentDraft(candidate as AgentDraft, tools)]
    } catch (error) {
      console.warn('[settings] ignored invalid agent:', error)
      return []
    }
  })
  return agents.length ? agents : copyDefaultAgents()
}

function validSkills(value: unknown, agents: AgentDefinition[]): SkillDefinition[] {
  if (!Array.isArray(value)) {
    const defaultAgentId = agents.some((agent) => agent.id === DEFAULT_AGENT_ID)
      ? DEFAULT_AGENT_ID
      : agents[0]?.id
    return defaultAgentId
      ? copyDefaultSkills().map((skill) => ({ ...skill, agentId: defaultAgentId }))
      : []
  }
  const labels = new Set<string>()
  return value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return []
    try {
      const skill = validateSkillDraft(candidate as SkillDraft, agents)
      if (labels.has(skill.label)) return []
      labels.add(skill.label)
      return [skill]
    } catch (error) {
      console.warn('[settings] ignored invalid skill:', error)
      return []
    }
  })
}

function mergeCredentialMetadata(
  stored: LocalCredentialMetadata[] | undefined,
  updates: LocalCredentialMetadata[],
): LocalCredentialMetadata[] {
  const merged = new Map<string, LocalCredentialMetadata>()
  for (const credential of Array.isArray(stored) ? stored : []) {
    if (credential && typeof credential.id === 'string'
      && ['openai', 'openai-codex'].includes(credential.provider)
      && ['connected', 'authentication_required'].includes(credential.status)) {
      merged.set(credential.id, credential)
    }
  }
  for (const credential of updates) merged.set(credential.id, credential)
  return [...merged.values()]
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  authMode: 'subscription',
  localCredentials: [],
  modelId: 'gpt-5.5',
  enabledToolIds: DEFAULT_ENABLED_TOOLS,
  customTools: [],
  agents: copyDefaultAgents(),
  skills: copyDefaultSkills(),
  isLoaded: false,
  error: null,

  load: async () => {
    try {
      const store = await getStore()
      const [authMode, openAiApiKey, oauthCredential, storedCredentials, modelId, enabledTools, storedTools, storedAgents, storedSkills] = await Promise.all([
        store.get<CodexAuthMode>(AUTH_MODE_FIELD),
        store.get<string>(API_KEY_FIELD),
        store.get<CodexOAuthCredential>(OAUTH_FIELD),
        store.get<LocalCredentialMetadata[]>(LOCAL_CREDENTIALS_FIELD),
        store.get<string>(MODEL_FIELD),
        store.get<string[]>(ENABLED_TOOLS_FIELD),
        store.get<CustomHttpToolConfig[]>(CUSTOM_TOOLS_FIELD),
        store.get<AgentDefinition[]>(AGENTS_FIELD),
        store.get<SkillDefinition[]>(SKILLS_FIELD),
      ])
      const customTools = validCustomTools(storedTools)
      const agents = validAgents(storedAgents, toolOptions(customTools))
      const skills = validSkills(storedSkills, agents)
      const migratedCredentials = await migrateLegacyCredentials(
        { apiKey: openAiApiKey, oauth: oauthCredential },
        nativeLocalCredentialVault,
      )
      const localCredentials = mergeCredentialMetadata(storedCredentials, migratedCredentials)
      if (Array.isArray(storedSkills)) await store.set(SKILLS_FIELD, skills)
      await store.set(LOCAL_CREDENTIALS_FIELD, localCredentials)
      await store.delete(API_KEY_FIELD)
      await store.delete(OAUTH_FIELD)
      await store.delete(LEGACY_ANTHROPIC_FIELD)
      await store.save()
      set({
        authMode: authMode === 'api_key' ? 'api_key' : 'subscription',
        localCredentials,
        modelId: modelId || 'gpt-5.5',
        enabledToolIds: Array.isArray(enabledTools) ? enabledTools : DEFAULT_ENABLED_TOOLS,
        customTools,
        agents,
        skills,
        isLoaded: true,
        error: null,
      })
    } catch (error) {
      const detail = message(error)
      console.error('[settings] load failed:', error)
      set({ isLoaded: true, error: detail })
    }
  },

  setAuthMode: async (authMode) => {
    set({ authMode, error: null })
    try {
      await saveField(AUTH_MODE_FIELD, authMode)
    } catch (error) {
      set({ error: message(error) })
      throw error
    }
  },

  setOpenAiApiKey: async (openAiApiKey) => {
    const previous = get().localCredentials
    const trimmed = openAiApiKey.trim()
    try {
      if (trimmed) await nativeLocalCredentialVault.store(LOCAL_OPENAI_CREDENTIAL_ID, trimmed)
      else await nativeLocalCredentialVault.remove(LOCAL_OPENAI_CREDENTIAL_ID)
      const localCredentials = trimmed
        ? mergeCredentialMetadata(previous, [{ id: LOCAL_OPENAI_CREDENTIAL_ID, provider: 'openai', status: 'connected' }])
        : previous.filter((credential) => credential.id !== LOCAL_OPENAI_CREDENTIAL_ID)
      set({ localCredentials, error: null })
      await saveField(LOCAL_CREDENTIALS_FIELD, localCredentials)
    } catch (error) {
      set({ localCredentials: previous, error: message(error) })
      throw error
    }
  },

  setOAuthCredential: async (oauthCredential) => {
    const previous = get().localCredentials
    try {
      const store = await getStore()
      if (oauthCredential) await nativeLocalCredentialVault.store(LOCAL_CODEX_CREDENTIAL_ID, JSON.stringify(oauthCredential))
      else await nativeLocalCredentialVault.remove(LOCAL_CODEX_CREDENTIAL_ID)
      const localCredentials = oauthCredential
        ? mergeCredentialMetadata(previous, [{
          id: LOCAL_CODEX_CREDENTIAL_ID,
          provider: 'openai-codex',
          status: 'connected',
          accountLabel: oauthCredential.accountId,
          expiresAt: new Date(oauthCredential.expires).toISOString(),
        }])
        : previous.filter((credential) => credential.id !== LOCAL_CODEX_CREDENTIAL_ID)
      set({ localCredentials, error: null })
      await store.set(LOCAL_CREDENTIALS_FIELD, localCredentials)
      await store.delete(OAUTH_FIELD)
      await store.save()
    } catch (error) {
      set({ localCredentials: previous, error: message(error) })
      throw error
    }
  },

  setModelId: async (modelId) => {
    set({ modelId, error: null })
    try {
      await saveField(MODEL_FIELD, modelId)
    } catch (error) {
      set({ error: message(error) })
      throw error
    }
  },

  setToolEnabled: async (toolId, enabled) => {
    const previous = get().enabledToolIds
    const enabledToolIds = enabled
      ? [...new Set([...previous, toolId])]
      : previous.filter((id) => id !== toolId)
    set({ enabledToolIds, error: null })
    try {
      await saveField(ENABLED_TOOLS_FIELD, enabledToolIds)
    } catch (error) {
      set({ enabledToolIds: previous, error: message(error) })
      throw error
    }
  },

  addCustomTool: async (draft) => {
    const valid = validateCustomToolDraft(draft)
    const previousTools = get().customTools
    const previousEnabled = get().enabledToolIds
    if (previousTools.some((tool) => tool.name === valid.name)) {
      throw new Error('A tool with that name already exists.')
    }
    const tool = { ...valid, id: crypto.randomUUID() }
    const customTools = [...previousTools, tool]
    const enabledToolIds = [...previousEnabled, tool.id]
    set({ customTools, enabledToolIds, error: null })
    try {
      const store = await getStore()
      await store.set(CUSTOM_TOOLS_FIELD, customTools)
      await store.set(ENABLED_TOOLS_FIELD, enabledToolIds)
      await store.save()
    } catch (error) {
      set({ customTools: previousTools, enabledToolIds: previousEnabled, error: message(error) })
      throw error
    }
  },

  removeCustomTool: async (toolId) => {
    const previousTools = get().customTools
    const previousEnabled = get().enabledToolIds
    const previousAgents = get().agents
    const customTools = previousTools.filter((tool) => tool.id !== toolId)
    const enabledToolIds = previousEnabled.filter((id) => id !== toolId)
    const agents = previousAgents.map((agent) => ({
      ...agent,
      toolIds: agent.toolIds.filter((id) => id !== toolId),
    }))
    set({ customTools, enabledToolIds, agents, error: null })
    try {
      const store = await getStore()
      await store.set(CUSTOM_TOOLS_FIELD, customTools)
      await store.set(ENABLED_TOOLS_FIELD, enabledToolIds)
      await store.set(AGENTS_FIELD, agents)
      await store.save()
    } catch (error) {
      set({ customTools: previousTools, enabledToolIds: previousEnabled, agents: previousAgents, error: message(error) })
      throw error
    }
  },

  saveAgent: async (draft) => {
    const previous = get().agents
    const agent = validateAgentDraft(draft, toolOptions(get().customTools))
    const agents = previous.some((item) => item.id === agent.id)
      ? previous.map((item) => item.id === agent.id ? agent : item)
      : [...previous, agent]
    set({ agents, error: null })
    try {
      await saveField(AGENTS_FIELD, agents)
    } catch (error) {
      set({ agents: previous, error: message(error) })
      throw error
    }
  },

  removeAgent: async (agentId) => {
    if (get().skills.some((skill) => skill.agentId === agentId)) {
      throw new Error('Remove or reassign this agent’s skills first.')
    }
    const previous = get().agents
    const agents = previous.filter((agent) => agent.id !== agentId)
    if (!agents.length) throw new Error('At least one agent is required.')
    set({ agents, error: null })
    try {
      await saveField(AGENTS_FIELD, agents)
    } catch (error) {
      set({ agents: previous, error: message(error) })
      throw error
    }
  },

  saveSkill: async (draft) => {
    const previous = get().skills
    const skill = validateSkillDraft(draft, get().agents)
    if (previous.some((item) => item.label === skill.label && item.id !== skill.id)) {
      throw new Error(`/${skill.label} already exists.`)
    }
    const skills = previous.some((item) => item.id === skill.id)
      ? previous.map((item) => item.id === skill.id ? skill : item)
      : [...previous, skill]
    set({ skills, error: null })
    try {
      await saveField(SKILLS_FIELD, skills)
    } catch (error) {
      set({ skills: previous, error: message(error) })
      throw error
    }
  },

  removeSkill: async (skillId) => {
    const previous = get().skills
    const skills = previous.filter((skill) => skill.id !== skillId)
    set({ skills, error: null })
    try {
      await saveField(SKILLS_FIELD, skills)
    } catch (error) {
      set({ skills: previous, error: message(error) })
      throw error
    }
  },

  resetAgentConfiguration: async () => {
    const previousAgents = get().agents
    const previousSkills = get().skills
    const agents = copyDefaultAgents()
    const skills = copyDefaultSkills()
    set({ agents, skills, error: null })
    try {
      const store = await getStore()
      await store.set(AGENTS_FIELD, agents)
      await store.set(SKILLS_FIELD, skills)
      await store.save()
    } catch (error) {
      set({ agents: previousAgents, skills: previousSkills, error: message(error) })
      throw error
    }
  },
}))
