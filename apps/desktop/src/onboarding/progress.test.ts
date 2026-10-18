import { describe, expect, it } from 'vitest'
import { createProgressStore, eligibleForAutomaticSetup, initialProgress, progressSchema } from './progress'

describe('device-local setup progress', () => {
  it('offers setup only after a genuinely new local outline and settings hydrate', () => {
    const fresh = { local: true, createdOutline: true, hadPriorSettings: false, settingsError: null }
    expect(eligibleForAutomaticSetup(fresh)).toBe(true)
    for (const changes of [{ local: false }, { createdOutline: false }, { hadPriorSettings: true }, { settingsError: 'Unreadable' }]) expect(eligibleForAutomaticSetup({ ...fresh, ...changes })).toBe(false)
  })
  it('resumes acknowledged progress, including pause and terminal markers, without rewriting it', async () => {
    for (const status of ['in-progress', 'paused', 'completed', 'skipped', 'not-offered'] as const) {
      const saved = { ...initialProgress(true, 'outline'), status, step: 'mcp' as const, noteId: 'note' }
      const writes: unknown[] = []
      const store = createProgressStore({ read: async () => saved, write: async value => { writes.push(value) } })
      await store.getState().initialize(true, 'outline')
      expect(store.getState().progress).toEqual(saved)
      expect(writes).toHaveLength(0)
    }
  })
  it('does not reset notes or automatically enter setup with corrupt or unreadable metadata', async () => {
    const invalid = createProgressStore({ read: async () => ({ version: 99 }), write: async () => { throw new Error('Must not rewrite') } })
    await invalid.getState().initialize(true, 'outline')
    expect(invalid.getState().progress?.status).toBe('not-offered')
    const unreadable = createProgressStore({ read: async () => { throw new Error('Read failed') }, write: async () => undefined })
    await expect(unreadable.getState().initialize(true)).rejects.toThrow('Read failed')
    expect(unreadable.getState().progress).toBeNull()
    expect(unreadable.getState().loaded).toBe(false)
  })
  it('serializes updates and keeps the last acknowledged state after a failed terminal write', async () => {
    let persisted = initialProgress(true, 'outline')
    let fail = true
    const writes: string[] = []
    const store = createProgressStore({ read: async () => persisted, write: async value => {
      if (value.status === 'completed' && fail) throw new Error('Disk full')
      writes.push(value.step); persisted = structuredClone(value)
    } })
    await store.getState().initialize(true)
    await Promise.all([store.getState().update({ noteId: 'note', step: 'ai' }), store.getState().update({ step: 'extensions' })])
    expect(store.getState().progress).toMatchObject({ noteId: 'note', step: 'extensions' })
    expect(writes).toEqual(['ai', 'extensions'])
    await expect(store.getState().update({ status: 'completed' })).rejects.toThrow('Disk full')
    expect(store.getState().progress?.status).toBe('in-progress')
    fail = false
    await store.getState().update({ status: 'completed' })
    expect(store.getState().progress?.status).toBe('completed')
  })
  it('rejects secret drafts, content, permission copies and unknown fields at the storage boundary', () => {
    for (const key of ['token', 'headers', 'command', 'env', 'noteText', 'transcript', 'grants', 'authorizationUrl']) expect(progressSchema.safeParse({ ...initialProgress(true), [key]: 'private' }).success).toBe(false)
    expect(progressSchema.safeParse({ ...initialProgress(true), mcp: [{ id: 'mcp', fingerprint: 'hash', token: 'private' }] }).success).toBe(false)
  })
})
