import { tmpdir } from 'node:os'
import { createRehydratedConversation, type RehydratedConversation } from '@forage/pi-runtime'
import type { AgentRunRecord, AgentStore, CallTurnEntries } from './agentStore.js'
import type { ResolvedModelCredential } from './credentialService.js'

/** Default per-call transcript budget; a reply to a larger call is refused. */
export const DEFAULT_CONVERSATION_BUDGET_BYTES = 2 * 1024 * 1024

/**
 * Rebuild the run's call conversation from the turns stored so far. Runs without a
 * thread, such as Inbox automation, are not conversations. Stored turns are only ever
 * settled ones, so a retried or lease-recovered attempt resumes from the last of them.
 */
export async function openCallConversation(
  store: Pick<AgentStore, 'conversationEntries'>,
  run: Pick<AgentRunRecord, 'input'>,
  tempRoot?: string,
): Promise<RehydratedConversation | undefined> {
  const thread = run.input.thread
  if (!thread) return undefined
  const committed = thread.turn > 1 ? await store.conversationEntries(thread.callId, thread.turn) : []
  return createRehydratedConversation(committed, { ...(tempRoot ? { tempRoot } : {}), cwd: tmpdir() })
}

/** The entries a settled turn stores: credential values and credential-shaped text redacted, with their size. */
export function settledTurnEntries(entries: readonly unknown[], credential: ResolvedModelCredential): CallTurnEntries {
  const secrets = credential.provider === 'openai' ? [credential.apiKey] : [credential.accessToken]
  const redacted = entries.map((entry) => redactValue(entry, secrets))
  return { entries: redacted, entryBytes: Buffer.byteLength(JSON.stringify(redacted), 'utf8') }
}

/**
 * Redact known credential values and credential-shaped text: `Bearer` tokens, `sk-`
 * keys and `token=`/`api_key=` assignments. Failure details and stored transcripts share it.
 */
export function redactCredentialText(text: string, secrets: readonly string[] = []): string {
  let redacted = text
  for (const secret of secrets) {
    if (secret.length >= 8) redacted = redacted.replaceAll(secret, '[redacted]')
  }
  return redacted
    .replace(/(?:\bsk-[A-Za-z0-9_-]{16,}|\bBearer\s+\S+)/gi, '[redacted]')
    .replace(/((?:refresh[_-]?token|access[_-]?token|api[_-]?key|device[_-]?code)\s*[=:]\s*)[^\s,;"']+/gi, '$1[redacted]')
}

function redactValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') return redactCredentialText(value, secrets)
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item, secrets)]))
  }
  return value
}
