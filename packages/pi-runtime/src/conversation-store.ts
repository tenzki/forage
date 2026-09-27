import { existsSync, mkdirSync, rmSync, statSync, truncateSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager, type FileEntry, type SessionEntry } from '@earendil-works/pi-coding-agent'
import type { RunThread } from '@forage/agent-runtime'

export type { RunThread }

export const CONVERSATION_UNAVAILABLE = "This conversation's history is no longer available. Run the skill again to start a new one."

const CALL_ID = /^[A-Za-z0-9_-]{1,128}$/

export interface ConversationTurn {
  sessionManager: SessionManager
  /** Entries this turn appended after the resumed transcript, in order. */
  appendedEntries: () => SessionEntry[]
  /**
   * Undo this turn's transcript writes after a failed or cancelled turn, so the
   * next reply resumes from the last completed turn. Safe to call repeatedly.
   */
  rollback: () => void | Promise<void>
}

/**
 * Where a call's agent conversation lives. Turn 1 starts a new conversation; later
 * turns resume the stored one and fail closed with CONVERSATION_UNAVAILABLE when it
 * is missing or unreadable. Local mode keeps a JSONL file per call; the server
 * rehydrates committed turns into a temporary file.
 */
export interface ConversationStore {
  openTurn: (thread: RunThread) => Promise<ConversationTurn>
}

/** The local store: `<directory>/<callId>.jsonl`, appended to by Pi and truncated on rollback. */
export function createFileConversationStore(directory: string, cwd = process.cwd()): ConversationStore {
  return { openTurn: async (thread) => openConversationTurn(directory, thread, cwd) }
}

export function parseRunThread(value: unknown): RunThread | undefined {
  if (value === undefined) return undefined
  const thread = value as Partial<RunThread> | null
  if (
    !thread || typeof thread !== 'object'
    || typeof thread.callId !== 'string' || !CALL_ID.test(thread.callId)
    || typeof thread.turn !== 'number' || !Number.isInteger(thread.turn) || thread.turn < 1
  ) {
    throw new Error('Agent invocation has an invalid conversation turn.')
  }
  return { callId: thread.callId, turn: thread.turn }
}

/** Session directory for call conversations under the agent data directory. */
export function conversationDirectory(agentDir: string): string {
  if (!agentDir) throw new Error('Conversation storage is unavailable.')
  return join(agentDir, 'agent-sessions')
}

/** The call's session file. The path is derived only from a validated call ID. */
export function conversationPath(directory: string, callId: string): string {
  if (!CALL_ID.test(callId)) throw new Error('Agent invocation has an invalid conversation turn.')
  return join(directory, `${callId}.jsonl`)
}

/**
 * Open the session for one turn of a call. Turn 1 starts a new conversation and
 * discards any stale file left by an interrupted first attempt; later turns resume
 * the stored conversation and fail closed when it is missing or unreadable.
 */
export function openConversationTurn(directory: string, thread: RunThread, cwd = process.cwd()): ConversationTurn {
  const path = conversationPath(directory, thread.callId)
  if (thread.turn === 1) {
    mkdirSync(directory, { recursive: true })
    rmSync(path, { force: true })
    const sessionManager = SessionManager.open(path, directory, cwd)
    return {
      sessionManager,
      appendedEntries: () => sessionManager.getEntries(),
      rollback: () => rmSync(path, { force: true }),
    }
  }

  if (!existsSync(path)) throw new Error(CONVERSATION_UNAVAILABLE)
  let sessionManager: SessionManager
  try {
    sessionManager = SessionManager.open(path, directory, cwd)
  } catch {
    throw new Error(CONVERSATION_UNAVAILABLE)
  }
  if (!sessionManager.getEntries().some((entry) => entry.type === 'message')) {
    throw new Error(CONVERSATION_UNAVAILABLE)
  }
  // Pi only appends to an opened session, so truncating restores the last completed turn.
  const size = statSync(path).size
  const resumedEntries = sessionManager.getEntries().length
  return {
    sessionManager,
    appendedEntries: () => sessionManager.getEntries().slice(resumedEntries),
    rollback: () => {
      if (existsSync(path) && statSync(path).size > size) truncateSync(path, size)
    },
  }
}

/**
 * A call conversation rebuilt from the entries a database stored for its settled turns.
 * Turn 1 starts in memory; a later turn writes the stored entries to a temporary
 * session file, resumes it, and reports what the turn appended so the caller can store
 * those entries when the run settles. Nothing is written back: a failed attempt leaves
 * the stored turns untouched, so a retry resumes from the last settled turn.
 */
export interface RehydratedConversation {
  store: ConversationStore
  /** Entries the opened turn appended; a first turn's entries begin with the session header. */
  appendedEntries: () => FileEntry[]
  /** Remove the temporary session file. Safe to call repeatedly. */
  dispose: () => Promise<void>
}

/**
 * @param committed The call's stored entries in turn order, starting with the session header.
 * @param tempRoot Where the per-attempt session directory is created; the OS temp directory by default.
 */
export function createRehydratedConversation(
  committed: readonly unknown[],
  options: { tempRoot?: string; cwd?: string } = {},
): RehydratedConversation {
  const cwd = options.cwd ?? process.cwd()
  let opened: { sessionManager: SessionManager; appended: () => FileEntry[] } | undefined
  let directory: string | undefined
  return {
    store: {
      openTurn: async (thread) => {
        if (opened) throw new Error('A rehydrated conversation opens one turn.')
        if (thread.turn === 1) {
          const sessionManager = SessionManager.inMemory(cwd)
          const header = sessionManager.getHeader()
          opened = { sessionManager, appended: () => [...(header ? [header] : []), ...sessionManager.getEntries()] }
        } else {
          if (!isStoredTranscript(committed)) throw new Error(CONVERSATION_UNAVAILABLE)
          directory = await mkdtemp(join(options.tempRoot ?? tmpdir(), 'forage-call-'))
          const path = join(directory, 'session.jsonl')
          await writeFile(path, committed.map((entry) => `${JSON.stringify(entry)}\n`).join(''), { mode: 0o600 })
          let sessionManager: SessionManager
          try {
            sessionManager = SessionManager.open(path, directory, cwd)
          } catch {
            throw new Error(CONVERSATION_UNAVAILABLE)
          }
          if (!sessionManager.getEntries().some((entry) => entry.type === 'message')) throw new Error(CONVERSATION_UNAVAILABLE)
          const resumed = sessionManager.getEntries().length
          opened = { sessionManager, appended: () => sessionManager.getEntries().slice(resumed) }
        }
        const turn = opened
        return { sessionManager: turn.sessionManager, appendedEntries: () => turn.appended().filter(isSessionEntry), rollback: () => undefined }
      },
    },
    appendedEntries: () => opened?.appended() ?? [],
    dispose: async () => {
      if (directory) await rm(directory, { recursive: true, force: true })
    },
  }
}

function isStoredTranscript(entries: readonly unknown[]): entries is FileEntry[] {
  const [header, ...rest] = entries
  return isRecord(header) && header.type === 'session'
    && rest.length > 0 && rest.every((entry) => isRecord(entry) && typeof entry.type === 'string' && entry.type !== 'session')
}

function isSessionEntry(entry: FileEntry): entry is SessionEntry {
  return entry.type !== 'session'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
