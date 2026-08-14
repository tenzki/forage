import { create } from 'zustand'
import { load, type Store } from '@tauri-apps/plugin-store'
import type { CodexOAuthCredential } from '../agent/codexAuth'

const STORE_FILE = 'settings.json'
const AUTH_MODE_FIELD = 'codexAuthMode'
const API_KEY_FIELD = 'openAiApiKey'
const OAUTH_FIELD = 'codexOAuthCredential'
const MODEL_FIELD = 'codexModelId'
const LEGACY_ANTHROPIC_FIELD = 'anthropicApiKey'

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
  isLoaded: boolean
  error: string | null
  load: () => Promise<void>
  setAuthMode: (mode: CodexAuthMode) => Promise<void>
  setOpenAiApiKey: (key: string) => Promise<void>
  setOAuthCredential: (credential: CodexOAuthCredential | null) => Promise<void>
  setModelId: (modelId: string) => Promise<void>
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export const useSettingsStore = create<SettingsState>((set) => ({
  authMode: 'subscription',
  openAiApiKey: '',
  oauthCredential: null,
  modelId: 'gpt-5.5',
  isLoaded: false,
  error: null,

  load: async () => {
    try {
      const store = await getStore()
      const [authMode, openAiApiKey, oauthCredential, modelId] = await Promise.all([
        store.get<CodexAuthMode>(AUTH_MODE_FIELD),
        store.get<string>(API_KEY_FIELD),
        store.get<CodexOAuthCredential>(OAUTH_FIELD),
        store.get<string>(MODEL_FIELD),
      ])
      await store.delete(LEGACY_ANTHROPIC_FIELD)
      await store.save()
      set({
        authMode: authMode === 'api_key' ? 'api_key' : 'subscription',
        openAiApiKey: openAiApiKey ?? '',
        oauthCredential: oauthCredential ?? null,
        modelId: modelId || 'gpt-5.5',
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
}))
