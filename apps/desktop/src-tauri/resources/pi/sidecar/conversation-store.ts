import { existsSync, mkdirSync, rmSync, statSync, truncateSync } from 'node:fs'
import { join } from 'node:path'
import { SessionManager } from '@earendil-works/pi-coding-agent'

export const CONVERSATION_UNAVAILABLE = "This conversation's history is no longer available. Run the skill again to start a new one."

const CALL_ID = /^[A-Za-z0-9_-]{1,128}$/

export interface RunThread {
  callId: string
  turn: number
}

export interface ConversationTurn {
  sessionManager: SessionManager
  /**
   * Undo this turn's transcript writes after a failed or cancelled turn, so the
   * next reply resumes from the last completed turn. Safe to call repeatedly.
   */
  rollback: () => void
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
    return { sessionManager, rollback: () => rmSync(path, { force: true }) }
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
  return {
    sessionManager,
    rollback: () => {
      if (existsSync(path) && statSync(path).size > size) truncateSync(path, size)
    },
  }
}
