// User messages for server call errors.
//
// Native server commands reject with `code: message`. Replies to a server call can
// be refused at admission (the call is busy, the turn was taken, the transcript is
// too large or gone), and a reply can fail on the worker when its transcript is
// unavailable. These map to messages that say what to do next.

export const SERVER_CALL_MESSAGES = {
  call_busy: 'This call is still working on a reply. Wait for it to finish, then reply again.',
  conflict: 'This call already has a newer reply, possibly from another device. Wait for it to appear here, then reply again.',
  conversation_too_large: 'This conversation is too long to continue. Run the skill again to start a new call.',
  conversation_unavailable: "This conversation's history is no longer available. Run the skill again to start a new one.",
} as const

type ServerCallErrorCode = keyof typeof SERVER_CALL_MESSAGES

const NATIVE_ERROR = /^([a-z_]+): /u

/** The error code of a rejected native server command, if it carried one. */
export function serverErrorCode(error: unknown): string | null {
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  return NATIVE_ERROR.exec(text)?.[1] ?? null
}

/**
 * The message for a failed server run or reply. A `conflict` means a stale turn
 * only for a reply; other errors keep their text.
 */
export function serverCallErrorMessage(error: unknown, reply: boolean): string {
  const code = serverErrorCode(error)
  if (code && code in SERVER_CALL_MESSAGES && (reply || code !== 'conflict')) {
    return SERVER_CALL_MESSAGES[code as ServerCallErrorCode]
  }
  return error instanceof Error ? error.message : String(error)
}

/** The message for a server run that ended as failed. */
export function serverRunFailureMessage(run: { error: { code: string; message: string } | null }): string {
  if (run.error?.code === 'conversation_unavailable') return SERVER_CALL_MESSAGES.conversation_unavailable
  return run.error?.message ?? 'The server run failed.'
}
