import { existsSync, mkdirSync, readFileSync, openSync, closeSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { MemoryStorage, type Storage } from '@earendil-works/pi-durable'
import { openNodeSqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite/node'
import { SqliteStorage } from '@earendil-works/pi-durable/storage/sqlite'
import type { RunThread } from '@forage/agent-runtime'

export type { RunThread }
export const CONVERSATION_UNAVAILABLE = "This conversation's history is no longer available. Run the skill again to start a new one."
const CALL_ID = /^[A-Za-z0-9_-]{1,128}$/

export interface ConversationTurn {
  storage: Storage
  /** Only used on first open, to import existing SDK sessions during upgrade. */
  legacyEntries?: readonly unknown[]
  /** Capture successful entries for the existing atomic result/turn contract. */
  complete?: (entries: unknown[]) => void
  close: () => Promise<void>
}

export interface ConversationStore {
  openTurn: (thread: RunThread) => Promise<ConversationTurn>
}

export function parseRunThread(value: unknown): RunThread | undefined {
  if (value === undefined) return undefined
  const thread = value as Partial<RunThread> | null
  if (!thread || typeof thread !== 'object' || typeof thread.callId !== 'string' || !CALL_ID.test(thread.callId)
    || typeof thread.turn !== 'number' || !Number.isInteger(thread.turn) || thread.turn < 1) {
    throw new Error('Agent invocation has an invalid conversation turn.')
  }
  return { callId: thread.callId, turn: thread.turn }
}

export function conversationDirectory(agentDir: string): string {
  if (!agentDir) throw new Error('Conversation storage is unavailable.')
  return join(agentDir, 'agent-sessions')
}

export function conversationPath(directory: string, callId: string): string {
  parseRunThread({ callId, turn: 1 })
  return join(directory, `${callId}.sqlite`)
}

/** One exclusively owned SQLite connection per call; committed checkpoints survive sidecar death. */
export function createFileConversationStore(directory: string): ConversationStore {
  return { openTurn: async (thread) => {
    parseRunThread(thread)
    const path = conversationPath(directory, thread.callId)
    const legacyPath = join(directory, `${thread.callId}.jsonl`)
    const existing = existsSync(path)
    let legacyEntries: unknown[] | undefined
    if (thread.turn > 1) {
      if (!existing && !existsSync(legacyPath)) throw new Error(CONVERSATION_UNAVAILABLE)
      if (existsSync(legacyPath)) {
        try {
          legacyEntries = readFileSync(legacyPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
          if (!legacyEntries.some((entry) => entry && typeof entry === 'object' && (entry as { type?: string }).type === 'message')) throw new Error(CONVERSATION_UNAVAILABLE)
        } catch { if (!existing) throw new Error(CONVERSATION_UNAVAILABLE) }
      }
    }
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    closeSync(openSync(path, 'a', 0o600))
    chmodSync(path, 0o600)
    const database = await openNodeSqliteDatabase(path, { busyTimeoutMs: 250 }).catch((error: unknown) => {
      if (error instanceof Error && /not a database|malformed/i.test(error.message)) throw new Error(CONVERSATION_UNAVAILABLE)
      throw error
    })
    try {
      // The upstream adapter has no process ownership. SQLite's exclusive locking
      // mode retains its lock until close, including between Harness commits.
      await database.exec('PRAGMA locking_mode = EXCLUSIVE')
      await database.exec('BEGIN EXCLUSIVE')
      await database.exec('COMMIT')
      await database.exec('PRAGMA synchronous = FULL')
      const storage = await SqliteStorage.open(database)
      return { storage, legacyEntries, close: () => storage.close(BACKGROUND_CONTEXT) }
    } catch (error) {
      await database.close()
      throw error
    }
  } }
}

export interface RehydratedConversation {
  store: ConversationStore
  appendedEntries: () => unknown[]
  dispose: () => Promise<void>
}

/** In-memory import is used by tests and old transcripts; production supplies durable storage. */
export function createRehydratedConversation(
  committed: readonly unknown[],
  openStorage?: () => Promise<Storage>,
): RehydratedConversation {
  let storage: Storage | undefined
  let entries: unknown[] = []
  return {
    store: { openTurn: async () => {
      if (storage) throw new Error('A conversation opens one turn.')
      storage = openStorage ? await openStorage() : new MemoryStorage()
      return {
        storage, legacyEntries: committed,
        complete: (appended) => { entries = appended },
        close: () => storage!.close(BACKGROUND_CONTEXT),
      }
    } },
    appendedEntries: () => entries,
    dispose: async () => { await storage?.close(BACKGROUND_CONTEXT) },
  }
}
