import { load } from '@tauri-apps/plugin-store'
import { z } from 'zod'
import { create } from 'zustand'

export const steps = ['note', 'ai', 'command', 'extensions', 'mcp', 'complete'] as const
const reference = z.string().min(1).max(256)
export const progressSchema = z.object({
  version: z.literal(1),
  status: z.enum(['in-progress', 'paused', 'skipped', 'completed', 'not-offered']),
  step: z.enum(steps),
  outlineId: reference.optional(),
  noteId: reference.optional(),
  invocationId: reference.optional(),
  runId: reference.optional(),
  compute: z.object({ provider: reference, modelId: reference, credentialRef: reference }).strict().optional(),
  extensions: z.array(z.object({ installationId: reference, revision: reference }).strict()).max(32),
  mcp: z.array(z.object({ id: reference, fingerprint: reference }).strict()).max(64),
  skipped: z.array(z.enum(['ai', 'command', 'extensions', 'mcp'])).max(4),
}).strict()
export type OnboardingProgress = z.infer<typeof progressSchema>
export type OnboardingStep = OnboardingProgress['step']

export function initialProgress(fresh: boolean, outlineId?: string): OnboardingProgress {
  return { version: 1, status: fresh ? 'in-progress' : 'not-offered', step: 'note', outlineId, extensions: [], mcp: [], skipped: [] }
}

export function eligibleForAutomaticSetup(input: { local: boolean; createdOutline: boolean; hadPriorSettings: boolean; settingsError: string | null }): boolean {
  return input.local && input.createdOutline && !input.hadPriorSettings && !input.settingsError
}

export interface ProgressStorage {
  read(): Promise<unknown>
  write(progress: OnboardingProgress): Promise<void>
}
const store = () => load('onboarding.json', { autoSave: false })
const nativeStorage: ProgressStorage = {
  read: async () => (await store()).get('progress'),
  write: async (progress) => {
    const file = await store()
    const previous = await file.get('progress')
    await file.set('progress', progress)
    try { await file.save() }
    catch (cause) {
      if (previous === undefined) await file.delete('progress')
      else await file.set('progress', previous)
      throw cause
    }
  },
}

/** Serialized writes publish only acknowledged progress. A failed write is retryable. */
export function createProgressStore(storage: ProgressStorage = nativeStorage) {
  let queue: Promise<unknown> = Promise.resolve()
  return create<{
    progress: OnboardingProgress | null
    loaded: boolean
    busy: boolean
    error: string | null
    initialize: (fresh: boolean, outlineId?: string) => Promise<void>
    save: (progress: OnboardingProgress) => Promise<void>
    update: (changes: Partial<OnboardingProgress>) => Promise<void>
  }>((set, get) => {
    const serialize = (operation: () => Promise<void>) => {
      const pending = queue.catch(() => undefined).then(async () => {
        set({ busy: true, error: null })
        try { await operation() }
        catch (cause) { set({ error: 'Setup progress could not be saved. Retry your action; your notes and saved configuration are kept.' }); throw cause }
        finally { set({ busy: false }) }
      })
      queue = pending
      return pending
    }
    const write = async (value: OnboardingProgress) => {
      const progress = progressSchema.parse(value)
      await storage.write(progress)
      set({ progress })
    }
    return {
      progress: null, loaded: false, busy: false, error: null,
      initialize: (fresh, outlineId) => serialize(async () => {
        if (get().loaded) return
        const saved = await storage.read()
        const parsed = progressSchema.safeParse(saved)
        // Corrupt metadata never resets a valid outline or starts setup automatically.
        if (saved !== undefined && saved !== null && !parsed.success) {
          set({ progress: initialProgress(false, outlineId), loaded: true })
          return
        }
        if (parsed.success) set({ progress: parsed.data, loaded: true })
        else { await write(initialProgress(fresh, outlineId)); set({ loaded: true }) }
      }),
      save: (progress) => serialize(() => write(progress)),
      update: (changes) => serialize(async () => {
        const current = get().progress
        if (!current) throw new Error('Setup progress is unavailable.')
        await write({ ...current, ...changes })
      }),
    }
  })
}

export const useOnboardingStore = createProgressStore()
