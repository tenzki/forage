import { describe, expect, it } from 'vitest'
import { registerStorageConformance } from '@earendil-works/pi-durable/testing'
import { JournalStorage, type JournalCommit } from './journal-storage'

registerStorageConformance({ describe, expect, it }, 'Forage durable journal', async (use) => {
  let next = 2
  const commits: JournalCommit[] = []
  const storage = await JournalStorage.open({
    load: async () => structuredClone(commits), mintId: async (minimum) => { next = Math.max(next, minimum); return next++ },
    append: async (commit) => { commits.push(structuredClone(commit)) }, close: async () => undefined,
  })
  try { await use(storage) } finally { await storage.close({ abortSignal: undefined, value: () => undefined, toString: () => 'test' }) }
})
