import { create } from 'zustand'
import { listen } from '@tauri-apps/api/event'
import { agentCommandIpc } from './ipc'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ProviderConfig {
  apiKey: string   // actual key (masked in UI, stored encrypted via sidecar keystore)
  enabled: boolean
}

export interface Settings {
  providers: {
    anthropic: ProviderConfig
    openai: ProviderConfig
    google: ProviderConfig
  }
  defaultModel: string  // e.g. 'claude-sonnet-4-20250514', 'gpt-4o', 'gemini-2.0-flash'
}

// ─── Store interface ──────────────────────────────────────────────────────────

interface SettingsStore {
  settings: Settings
  isLoaded: boolean

  loadSettings: () => Promise<void>
  saveProviderKey: (provider: keyof Settings['providers'], apiKey: string) => Promise<void>
  removeProviderKey: (provider: keyof Settings['providers']) => Promise<void>
  setDefaultModel: (model: string) => Promise<void>
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

const defaultSettings: Settings = {
  providers: {
    anthropic: { apiKey: '', enabled: false },
    openai:    { apiKey: '', enabled: false },
    google:    { apiKey: '', enabled: false },
  },
  defaultModel: 'claude-sonnet-4-20250514',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Send a command to the sidecar and wait for the matching response on 'agent-event'.
 * Commands include a request ID; responses are matched by ID to handle out-of-order delivery.
 */
async function sendAndReceive<T>(command: object & { id: string }): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      unlisten()
      reject(new Error(`Sidecar timeout waiting for response to command id=${command.id}`))
    }, 10_000)

    let unlisten: () => void = () => {}

    listen<{ type: string; id?: string; data?: T; error?: string }>('agent-event', (event) => {
      const payload = event.payload
      // Match by request ID if present
      if (payload.id && payload.id !== command.id) return
      clearTimeout(timeout)
      unlisten()
      if (payload.error) {
        reject(new Error(payload.error))
      } else {
        resolve(payload.data as T)
      }
    })
      .then((fn) => { unlisten = fn })
      .catch(reject)

    // Send command after setting up the listener
    agentCommandIpc(command).catch((err) => {
      clearTimeout(timeout)
      unlisten()
      reject(err)
    })
  })
}

async function persistSettings(settings: Settings): Promise<void> {
  await agentCommandIpc({ type: 'save_settings', data: settings })
}

// ─── Store ────────────────────────────────────────────────────────────────────

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  settings: defaultSettings,
  isLoaded: false,

  async loadSettings() {
    try {
      const id = crypto.randomUUID()
      const data = await sendAndReceive<Settings>({ type: 'get_settings', id })
      if (data && typeof data === 'object') {
        // Merge with defaults to handle partial saved settings
        const merged: Settings = {
          providers: {
            anthropic: { ...defaultSettings.providers.anthropic, ...data.providers?.anthropic },
            openai:    { ...defaultSettings.providers.openai,    ...data.providers?.openai },
            google:    { ...defaultSettings.providers.google,    ...data.providers?.google },
          },
          defaultModel: data.defaultModel ?? defaultSettings.defaultModel,
        }
        set({ settings: merged, isLoaded: true })
      } else {
        set({ isLoaded: true })
      }
    } catch {
      // Sidecar not running or no settings yet — use defaults
      set({ isLoaded: true })
    }
  },

  async saveProviderKey(provider, apiKey) {
    const current = get().settings
    const updated: Settings = {
      ...current,
      providers: {
        ...current.providers,
        [provider]: { apiKey, enabled: apiKey.length > 0 },
      },
    }
    set({ settings: updated })
    await persistSettings(updated)
  },

  async removeProviderKey(provider) {
    const current = get().settings
    const updated: Settings = {
      ...current,
      providers: {
        ...current.providers,
        [provider]: { apiKey: '', enabled: false },
      },
    }
    set({ settings: updated })
    await persistSettings(updated)
  },

  async setDefaultModel(model) {
    const current = get().settings
    const updated: Settings = { ...current, defaultModel: model }
    set({ settings: updated })
    await persistSettings(updated)
  },
}))
