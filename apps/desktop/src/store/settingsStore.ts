import { create } from 'zustand'
import { cacheTheme } from '../themeCache'
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
  isExtensionSkill,
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
import { skillDefinitionSchema, type PortableAgentConfiguration } from '@forage/agent-runtime'
import { apiKeyProviderSchema, validateProviderConnection, type ApiKeyProvider } from '@forage/agent-runtime'
import { getProviderModels } from '@forage/pi-runtime/provider-catalog'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import {
  DEFAULT_DEVICE_PREFERENCES, LOCAL_SETTINGS_FIELD, localAccountMetadataSchema, devicePreferencesSchema,
  localSettingsSchema, migrateLocalSettings, type DevicePreferences, type LocalSettings,
} from './settingsMigration'

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

let localSettingsWrite: Promise<void> = Promise.resolve()
let accountMutation: Promise<void> = Promise.resolve()

function updateAccount(operation: () => Promise<void>): Promise<void> {
  const pending = accountMutation.catch(() => undefined).then(operation)
  accountMutation = pending
  return pending
}

async function loadPreviousSecret(reference: string): Promise<string | null> {
  try { return await nativeLocalCredentialVault.load(reference) }
  catch (error) {
    if (String(error).includes('stored credential is missing')) return null
    throw new Error('Could not access the stored credential. Try again before replacing or disconnecting it.')
  }
}

function saveLocalSettings(state: SettingsState): Promise<void> {
  const settings = localSettingsSchema.parse({
    version: 1, accounts: state.localCredentials, compute: state.localCompute, preferences: state.devicePreferences,
  })
  const authMode = state.authMode
  const write = localSettingsWrite.catch(() => undefined).then(async () => {
    const store = await getStore()
    const fields = [LOCAL_SETTINGS_FIELD, LOCAL_CREDENTIALS_FIELD, AUTH_MODE_FIELD, MODEL_FIELD]
    const previous = await Promise.all(fields.map((field) => store.get(field)))
    try {
      await store.set(LOCAL_SETTINGS_FIELD, settings)
      await store.set(LOCAL_CREDENTIALS_FIELD, settings.accounts)
      await store.set(AUTH_MODE_FIELD, authMode)
      await store.set(MODEL_FIELD, settings.compute.modelId)
      await store.save()
    } catch (error) {
      for (const [index, field] of fields.entries()) {
        if (previous[index] === undefined) await store.delete(field)
        else await store.set(field, previous[index])
      }
      await store.save().catch(() => undefined)
      throw error
    }
  })
  localSettingsWrite = write
  return write
}

interface SettingsState {
  authMode: CodexAuthMode
  localCredentials: LocalCredentialMetadata[]
  modelId: string
  localCompute: LocalSettings['compute']
  devicePreferences: DevicePreferences
  preferenceError: string | null
  setDevicePreferences: (preferences: Partial<DevicePreferences>) => Promise<void>
  enabledToolIds: string[]
  customTools: CustomHttpToolConfig[]
  agents: AgentDefinition[]
  skills: SkillDefinition[]
  isLoaded: boolean
  hadPriorSettings: boolean
  error: string | null
  load: () => Promise<void>
  connectApiKey: (provider: ApiKeyProvider, key: string, signal?: AbortSignal) => Promise<void>
  disconnectAccount: (credentialId: string) => Promise<void>
  selectLocalCompute: (selection: LocalSettings['compute']) => Promise<void>
  setAuthMode: (mode: CodexAuthMode) => Promise<void>
  setOpenAiApiKey: (key: string) => Promise<void>
  setOAuthCredential: (credential: CodexOAuthCredential | null) => Promise<void>
  setModelId: (modelId: string) => Promise<void>
  setToolEnabled: (toolId: string, enabled: boolean) => Promise<void>
  grantMcpToolAccess: (toolIds: string[], agentIds: string[], reviewedToolIds?: string[]) => Promise<void>
  addCustomTool: (draft: CustomHttpToolDraft) => Promise<void>
  removeCustomTool: (toolId: string) => Promise<void>
  removeToolReferences: (toolIds: string[]) => Promise<void>
  saveAgent: (draft: AgentDraft) => Promise<void>
  removeAgent: (agentId: string) => Promise<void>
  saveSkill: (draft: SkillDraft) => Promise<void>
  removeSkill: (skillId: string) => Promise<void>
  resetAgentConfiguration: () => Promise<void>
  replaceAgentConfiguration: (configuration: PortableAgentConfiguration) => Promise<void>
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
      const raw = candidate as Record<string, unknown>
      const skill = raw.execution === 'extension'
        ? skillDefinitionSchema.parse(candidate)
        : validateSkillDraft(candidate as SkillDraft, agents)
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
    const parsed = localAccountMetadataSchema.safeParse(credential)
    if (parsed.success) merged.set(parsed.data.id, parsed.data)
  }
  for (const credential of updates) merged.set(credential.id, credential)
  return [...merged.values()]
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  authMode: 'subscription',
  localCredentials: [],
  modelId: 'gpt-5.5',
  localCompute: { provider: 'openai-codex', modelId: 'gpt-5.5', credentialRef: LOCAL_CODEX_CREDENTIAL_ID },
  devicePreferences: { ...DEFAULT_DEVICE_PREFERENCES },
  preferenceError: null,
  setDevicePreferences: async (changes) => {
    const devicePreferences = devicePreferencesSchema.parse({ ...get().devicePreferences, ...changes })
    set({ devicePreferences, preferenceError: null })
    return updateAccount(async () => {
      try {
        const settings = get()
        await saveLocalSettings(settings)
        cacheTheme(settings.devicePreferences.theme)
        set({ preferenceError: null })
      } catch {
        set({ preferenceError: 'Appearance is applied but could not be saved. Retry to keep it after restart.' })
      }
    })
  },
  enabledToolIds: DEFAULT_ENABLED_TOOLS,
  customTools: [],
  agents: copyDefaultAgents(),
  skills: copyDefaultSkills(),
  isLoaded: false,
  hadPriorSettings: true,
  error: null,

  connectApiKey: async (provider, key, signal) => updateAccount(async () => {
    apiKeyProviderSchema.parse(provider)
    await validateProviderConnection(provider, key, { fetch: tauriFetch, signal })
    signal?.throwIfAborted()
    const previous = get().localCredentials
    const existing = previous.find((account) => account.provider === provider)
    const reference = existing?.id ?? `local-${provider}`
    const previousSecret = existing ? await loadPreviousSecret(reference) : null
    await nativeLocalCredentialVault.store(reference, key.trim())
    const localCredentials = mergeCredentialMetadata(previous, [{ id: reference, provider, status: 'connected' }])
    try {
      signal?.throwIfAborted()
      await saveLocalSettings({ ...get(), localCredentials })
      set({ localCredentials, error: null })
    } catch (error) {
      if (previousSecret !== null) await nativeLocalCredentialVault.store(reference, previousSecret)
      else await nativeLocalCredentialVault.remove(reference)
      throw error
    }
  }),

  disconnectAccount: async (credentialId) => updateAccount(async () => {
    const account = get().localCredentials.find((entry) => entry.id === credentialId)
    if (!account) return
    const secret = await loadPreviousSecret(credentialId)
    const localCredentials = get().localCredentials.filter((entry) => entry.id !== credentialId)
    await nativeLocalCredentialVault.remove(credentialId)
    try {
      await saveLocalSettings({ ...get(), localCredentials })
      set({ localCredentials, error: null })
    } catch (error) {
      if (secret !== null) await nativeLocalCredentialVault.store(credentialId, secret)
      throw error
    }
  }),

  selectLocalCompute: async (selection) => updateAccount(async () => {
    const localCompute = localSettingsSchema.parse({ version: 1, accounts: get().localCredentials, compute: selection, preferences: get().devicePreferences }).compute
    const account = get().localCredentials.find((entry) => entry.id === selection.credentialRef && entry.provider === selection.provider && entry.status === 'connected')
    if (!account) throw new Error('Connect the selected provider account first.')
    if (!getProviderModels(selection.provider).some((model) => model.id === selection.modelId)) throw new Error('Model is unavailable for the selected provider.')
    const authMode = selection.provider === 'openai-codex' ? 'subscription' : 'api_key'
    await saveLocalSettings({ ...get(), localCompute, modelId: selection.modelId, authMode })
    set({ localCompute, modelId: selection.modelId, authMode, error: null })
  }),

  load: async () => {
    try {
      const store = await getStore()
      const [authMode, openAiApiKey, oauthCredential, storedCredentials, modelId, enabledTools, storedTools, storedAgents, storedSkills, storedLocalSettings] = await Promise.all([
        store.get<CodexAuthMode>(AUTH_MODE_FIELD),
        store.get<string>(API_KEY_FIELD),
        store.get<CodexOAuthCredential>(OAUTH_FIELD),
        store.get<LocalCredentialMetadata[]>(LOCAL_CREDENTIALS_FIELD),
        store.get<string>(MODEL_FIELD),
        store.get<string[]>(ENABLED_TOOLS_FIELD),
        store.get<CustomHttpToolConfig[]>(CUSTOM_TOOLS_FIELD),
        store.get<AgentDefinition[]>(AGENTS_FIELD),
        store.get<SkillDefinition[]>(SKILLS_FIELD),
        store.get<unknown>(LOCAL_SETTINGS_FIELD),
      ])
      const customTools = validCustomTools(storedTools)
      const hadPriorSettings = [authMode, openAiApiKey, oauthCredential, storedCredentials, modelId, enabledTools, storedTools, storedAgents, storedSkills, storedLocalSettings].some((value) => value !== undefined && value !== null)
      const agents = validAgents(storedAgents, toolOptions(customTools))
      const skills = validSkills(storedSkills, agents)
      if (storedLocalSettings !== undefined && storedLocalSettings !== null) localSettingsSchema.parse(storedLocalSettings)
      const migratedCredentials = await migrateLegacyCredentials(
        { apiKey: openAiApiKey, oauth: oauthCredential },
        nativeLocalCredentialVault,
      )
      const migratedSettings = migrateLocalSettings(storedLocalSettings, {
        authMode, modelId, accounts: mergeCredentialMetadata(storedCredentials, migratedCredentials),
      })
      const localCredentials = mergeCredentialMetadata(migratedSettings.accounts, migratedCredentials)
      const localSettings = localSettingsSchema.parse({ ...migratedSettings, accounts: localCredentials })
      if (Array.isArray(storedSkills)) await store.set(SKILLS_FIELD, skills)
      await store.set(LOCAL_CREDENTIALS_FIELD, localCredentials)
      await store.set(LOCAL_SETTINGS_FIELD, localSettings)
      await store.delete(API_KEY_FIELD)
      await store.delete(OAUTH_FIELD)
      await store.delete(LEGACY_ANTHROPIC_FIELD)
      await store.save()
      cacheTheme(localSettings.preferences.theme)
      set({
        authMode: localSettings.compute.provider === 'openai-codex' ? 'subscription' : 'api_key',
        localCredentials,
        modelId: localSettings.compute.modelId,
        localCompute: localSettings.compute,
        devicePreferences: localSettings.preferences,
        preferenceError: null,
        enabledToolIds: Array.isArray(enabledTools) ? enabledTools : DEFAULT_ENABLED_TOOLS,
        customTools,
        agents,
        skills,
        isLoaded: true,
        hadPriorSettings,
        error: null,
      })
    } catch (error) {
      const detail = message(error)
      console.error('[settings] load failed:', error)
      set({ isLoaded: true, error: detail })
    }
  },

  setAuthMode: async (authMode) => {
    const previous = { authMode: get().authMode, localCompute: get().localCompute }
    const provider = authMode === 'api_key' ? 'openai' : 'openai-codex'
    const localCompute = {
      ...get().localCompute, provider,
      credentialRef: get().localCredentials.find((account) => account.provider === provider)?.id
        ?? (provider === 'openai' ? LOCAL_OPENAI_CREDENTIAL_ID : LOCAL_CODEX_CREDENTIAL_ID),
    } as LocalSettings['compute']
    set({ authMode, localCompute, error: null })
    try {
      await saveLocalSettings(get())
    } catch (error) {
      set({ ...previous, error: message(error) })
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
      await saveLocalSettings(get())
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
      await store.delete(OAUTH_FIELD)
      await saveLocalSettings(get())
    } catch (error) {
      set({ localCredentials: previous, error: message(error) })
      throw error
    }
  },

  setModelId: async (modelId) => {
    const previous = { modelId: get().modelId, localCompute: get().localCompute }
    const localCompute = { ...get().localCompute, modelId }
    localSettingsSchema.parse({ version: 1, accounts: get().localCredentials, compute: localCompute, preferences: get().devicePreferences })
    set({ modelId, localCompute, error: null })
    try {
      await saveLocalSettings(get())
    } catch (error) {
      set({ ...previous, error: message(error) })
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

  grantMcpToolAccess: async (toolIds, agentIds, reviewedToolIds) => {
    const previous = { agents: get().agents, enabledToolIds: get().enabledToolIds }
    if ((!reviewedToolIds && !toolIds.length) || [...toolIds, ...(reviewedToolIds ?? [])].some((id) => !/^mcp_[ls]_[a-f0-9]{48}$/.test(id))
      || (reviewedToolIds && toolIds.some((id) => !reviewedToolIds.includes(id)))) throw new Error('Choose MCP tools to enable.')
    if ((!reviewedToolIds && !agentIds.length) || agentIds.some((id) => !previous.agents.some((agent) => agent.id === id))) throw new Error('Choose an existing agent.')
    const agents = previous.agents.map((agent) => agentIds.includes(agent.id) ? { ...agent, toolIds: [...new Set([...agent.toolIds, ...toolIds])] } : agent)
    const enabledToolIds = [...new Set([...previous.enabledToolIds.filter((id) => !reviewedToolIds?.includes(id)), ...toolIds])]
    if (enabledToolIds.length > 64 || agents.some((agent) => agent.toolIds.length > 64)) throw new Error('At most 64 tools can be enabled or assigned to an agent. Select fewer tools.')
    try {
      const store = await getStore()
      await store.set(AGENTS_FIELD, agents)
      await store.set(ENABLED_TOOLS_FIELD, enabledToolIds)
      await store.save()
      set({ agents, enabledToolIds, error: null })
    } catch (error) {
      set({ error: message(error) })
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

  removeToolReferences: async (toolIds) => {
    const removed = new Set(toolIds)
    const previous = { enabledToolIds: get().enabledToolIds, agents: get().agents, skills: get().skills }
    const enabledToolIds = previous.enabledToolIds.filter((id) => !removed.has(id))
    const agents = previous.agents.map((agent) => ({ ...agent, toolIds: agent.toolIds.filter((id) => !removed.has(id)) }))
    const skills = previous.skills.map((skill) => isExtensionSkill(skill) ? skill : {
      ...skill, requiredToolIds: (skill.requiredToolIds ?? []).filter((id) => !removed.has(id)),
    })
    set({ enabledToolIds, agents, skills, error: null })
    try {
      const store = await getStore()
      await store.set(ENABLED_TOOLS_FIELD, enabledToolIds)
      await store.set(AGENTS_FIELD, agents)
      await store.set(SKILLS_FIELD, skills)
      await store.save()
    } catch (error) {
      set({ ...previous, error: message(error) })
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
    if (get().skills.some((skill) => (!('execution' in skill) || skill.execution === 'llm') && skill.agentId === agentId)) {
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

  replaceAgentConfiguration: async (configuration) => {
    const previous = {
      agents: get().agents,
      skills: get().skills,
      customTools: get().customTools,
      enabledToolIds: get().enabledToolIds,
    }
    const customTools = validCustomTools(configuration.customTools)
    const agents = validAgents(configuration.agents, toolOptions(customTools))
    const skills = validSkills(configuration.skills, agents)
    const enabledToolIds = [...configuration.globallyEnabledToolIds]
    set({ agents, skills, customTools, enabledToolIds, error: null })
    try {
      const store = await getStore()
      await store.set(AGENTS_FIELD, agents)
      await store.set(SKILLS_FIELD, skills)
      await store.set(CUSTOM_TOOLS_FIELD, customTools)
      await store.set(ENABLED_TOOLS_FIELD, enabledToolIds)
      await store.save()
    } catch (error) {
      set({ ...previous, error: message(error) })
      throw error
    }
  },
}))
