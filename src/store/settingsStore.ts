import { create } from 'zustand'
import { load, type Store } from '@tauri-apps/plugin-store'
import type { CodexOAuthCredential } from '../agent/codexAuth'
import {
  validateCustomToolDraft,
  type CustomHttpToolConfig,
  type CustomHttpToolDraft,
} from '../agent/tools'

const STORE_FILE = 'settings.json'
const AUTH_MODE_FIELD = 'codexAuthMode'
const API_KEY_FIELD = 'openAiApiKey'
const OAUTH_FIELD = 'codexOAuthCredential'
const MODEL_FIELD = 'codexModelId'
const ENABLED_TOOLS_FIELD = 'enabledTools'
const CUSTOM_TOOLS_FIELD = 'customHttpTools'
const LEGACY_ANTHROPIC_FIELD = 'anthropicApiKey'

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
  openAiApiKey: string
  oauthCredential: CodexOAuthCredential | null
  modelId: string
  enabledToolIds: string[]
  customTools: CustomHttpToolConfig[]
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
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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

export const useSettingsStore = create<SettingsState>((set, get) => ({
  authMode: 'subscription',
  openAiApiKey: '',
  oauthCredential: null,
  modelId: 'gpt-5.5',
  enabledToolIds: DEFAULT_ENABLED_TOOLS,
  customTools: [],
  isLoaded: false,
  error: null,

  load: async () => {
    try {
      const store = await getStore()
      const [authMode, openAiApiKey, oauthCredential, modelId, enabledTools, customTools] = await Promise.all([
        store.get<CodexAuthMode>(AUTH_MODE_FIELD),
        store.get<string>(API_KEY_FIELD),
        store.get<CodexOAuthCredential>(OAUTH_FIELD),
        store.get<string>(MODEL_FIELD),
        store.get<string[]>(ENABLED_TOOLS_FIELD),
        store.get<CustomHttpToolConfig[]>(CUSTOM_TOOLS_FIELD),
      ])
      await store.delete(LEGACY_ANTHROPIC_FIELD)
      await store.save()
      set({
        authMode: authMode === 'api_key' ? 'api_key' : 'subscription',
        openAiApiKey: openAiApiKey ?? '',
        oauthCredential: oauthCredential ?? null,
        modelId: modelId || 'gpt-5.5',
        enabledToolIds: Array.isArray(enabledTools) ? enabledTools : DEFAULT_ENABLED_TOOLS,
        customTools: validCustomTools(customTools),
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
    set({ openAiApiKey, error: null })
    try {
      await saveField(API_KEY_FIELD, openAiApiKey)
    } catch (error) {
      set({ error: message(error) })
      throw error
    }
  },

  setOAuthCredential: async (oauthCredential) => {
    set({ oauthCredential, error: null })
    try {
      const store = await getStore()
      if (oauthCredential) await store.set(OAUTH_FIELD, oauthCredential)
      else await store.delete(OAUTH_FIELD)
      await store.save()
    } catch (error) {
      set({ error: message(error) })
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
    const customTools = previousTools.filter((tool) => tool.id !== toolId)
    const enabledToolIds = previousEnabled.filter((id) => id !== toolId)
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
}))
