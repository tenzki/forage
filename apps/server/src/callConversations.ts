import { createRehydratedConversation, redactValue, type RehydratedConversation, type Storage } from '@forage/pi-runtime'
export { redactCredentialText } from '@forage/pi-runtime'
import type { AgentRunRecord, AgentStore, CallTurnEntries } from './agentStore.js'
import type { ResolvedModelCredential } from './credentialService.js'

/** Default per-call transcript budget; a reply to a larger call is refused. */
export const DEFAULT_CONVERSATION_BUDGET_BYTES = 2 * 1024 * 1024

/**
 * Open the call's durable checkpoint store. Settled turn entries seed legacy calls
 * on first use; an existing journal resumes in-flight work. Automation also receives
 * a durable execution store, without becoming a user-reply conversation.
 */
export async function openCallConversation(
  store: Pick<AgentStore, 'conversationEntries'>,
  run: Pick<AgentRunRecord, 'input'>,
  openStorage?: () => Promise<Storage>,
): Promise<RehydratedConversation | undefined> {
  const thread = run.input.thread
  if (!thread && !openStorage) return undefined
  const committed = thread && thread.turn > 1 ? await store.conversationEntries(thread.callId, thread.turn) : []
  return createRehydratedConversation(committed, openStorage)
}

/** The entries a settled turn stores: credential values and credential-shaped text redacted, with their size. */
export function settledTurnEntries(entries: readonly unknown[], credential: ResolvedModelCredential): CallTurnEntries {
  const secrets = credential.provider !== 'openai-codex' ? [credential.apiKey] : [credential.accessToken]
  const redacted = entries.map((entry) => redactValue(entry, secrets))
  return { entries: redacted, entryBytes: Buffer.byteLength(JSON.stringify(redacted), 'utf8') }
}
