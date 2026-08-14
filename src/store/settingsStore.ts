// Settings persisted via @tauri-apps/plugin-store (JSON on disk in the app's
// data dir). v1 holds just the user's Anthropic API key (INFR-01). No sidecar,
// no custom Rust command — the plugin owns the file.

import { create } from 'zustand'
import { load, type Store } from '@tauri-apps/plugin-store'

const STORE_FILE = 'settings.json'
const KEY_FIELD = 'anthropicApiKey'

let storePromise: Promise<Store> | null = null
function getStore(): Promise<Store> {
  return (storePromise ??= load(STORE_FILE, { autoSave: true }))
}

interface SettingsState {
  apiKey: string
  isLoaded: boolean
  load: () => Promise<void>
  setApiKey: (key: string) => Promise<void>
}

export const useSettingsStore = create<SettingsState>((set) => ({
  apiKey: '',
  isLoaded: false,

  load: async () => {
    try {
      const store = await getStore()
      const key = (await store.get<string>(KEY_FIELD)) ?? ''
      set({ apiKey: key, isLoaded: true })
    } catch (e) {
      console.error('[settings] load failed:', e)
      set({ isLoaded: true })
    }
  },

  setApiKey: async (key: string) => {
    set({ apiKey: key })
    try {
      const store = await getStore()
      await store.set(KEY_FIELD, key)
      await store.save()
    } catch (e) {
      console.error('[settings] save failed:', e)
    }
  },
}))
