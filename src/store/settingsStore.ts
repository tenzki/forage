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
 * Commands include a request ID; responses are matched by both type and ID to avoid
 * spurious resolution from unrelated events that lack an id field.
 *
 * Expected response types per command:
 *   get_settings  -> 'settings'
 *   save_settings -> 'settings_saved'
 */
const RESPONSE_TYPES: Record<string, string> = {
  get_settings: 'settings',
  save_settings: 'settings_saved',
}

async function sendAndReceive<T>(command: Record<string, unknown> & { id: string }): Promise<T> {
  const expectedType = RESPONSE_TYPES[command.type as string]

  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      unlisten()
      reject(new Error(`Sidecar timeout waiting for response to command id=${command.id}`))
    }, 10_000)

    let unlisten: () => void = () => {}

    listen<{ type: string; id?: string; data?: T; error?: string }>('agent-event', (event) => {
      const payload = event.payload

      // Must match by request ID — reject events without an id or with a different id
      if (!payload.id || payload.id !== command.id) return

      // Must match expected response type (if known) to avoid reacting to unrelated events
      if (expectedType && payload.type !== expectedType && payload.type !== 'error') return

      clearTimeout(timeout)
      unlisten()
      if (payload.type === 'error' || payload.error) {
        reject(new Error(payload.error ?? `Sidecar returned error for command ${command.type}`))
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
  const id = crypto.randomUUID()
  await sendAndReceive<void>({ type: 'save_settings', id, data: settings })
}

// ─── Store ────────────────────────────────────────────────────────────────────

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  settings: defaultSettings,
  isLoaded: false,

  async loadSettings() {
    // Retry up to 5 times with 500ms delay to handle the startup race where the
    // sidecar hasn't been spawned yet when the Settings page first mounts.
    const MAX_ATTEMPTS = 5
    const RETRY_DELAY_MS = 500

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
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
          // Sidecar returned empty/null data — no saved settings, use defaults
          set({ isLoaded: true })
        }
        return  // Success — stop retrying
      } catch (err) {
        const isSidecarNotRunning =
          err instanceof Error && err.message.includes('Sidecar is not running')
        if (isSidecarNotRunning && attempt < MAX_ATTEMPTS) {
          // Sidecar still starting up — wait and retry
          await new Promise<void>((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
          continue
        }
        // Non-retryable error or max retries exceeded — fall back to defaults silently
        set({ isLoaded: true })
        return
      }
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
