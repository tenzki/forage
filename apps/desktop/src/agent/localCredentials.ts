import type { CodexAuthConfig } from './client'
import type { CodexOAuthCredential } from './codexAuth'
import { invoke } from '@tauri-apps/api/core'

export const LOCAL_OPENAI_CREDENTIAL_ID = 'local-openai'
export const LOCAL_CODEX_CREDENTIAL_ID = 'local-openai-codex'

export interface LocalCredentialMetadata {
  id: string
  provider: 'openai' | 'openai-codex'
  status: 'connected' | 'authentication_required'
  accountLabel?: string
  expiresAt?: string
}

export const nativeLocalCredentialVault = {
  store: (reference: string, secret: string): Promise<void> => invoke('local_credential_store', { reference, secret }),
  load: (reference: string): Promise<string> => invoke('local_credential_load', { reference }),
  remove: (reference: string): Promise<void> => invoke('local_credential_remove', { reference }),
}

export async function migrateLegacyCredentials(
  legacy: { apiKey?: string | null; oauth?: CodexOAuthCredential | null },
  vault: { store: (reference: string, secret: string) => Promise<void> },
): Promise<LocalCredentialMetadata[]> {
  const metadata: LocalCredentialMetadata[] = []
  const apiKey = legacy.apiKey?.trim()
  if (apiKey) {
    await vault.store(LOCAL_OPENAI_CREDENTIAL_ID, apiKey)
    metadata.push({ id: LOCAL_OPENAI_CREDENTIAL_ID, provider: 'openai', status: 'connected' })
  }
  if (legacy.oauth) {
    assertOAuthCredential(legacy.oauth)
    await vault.store(LOCAL_CODEX_CREDENTIAL_ID, JSON.stringify(legacy.oauth))
    metadata.push({
      id: LOCAL_CODEX_CREDENTIAL_ID,
      provider: 'openai-codex',
      status: 'connected',
      accountLabel: legacy.oauth.accountId,
      expiresAt: new Date(legacy.oauth.expires).toISOString(),
    })
  }
  return metadata
}

export async function resolveLocalCredential(
  metadata: LocalCredentialMetadata,
  vault: { load: (reference: string) => Promise<string> },
): Promise<CodexAuthConfig> {
  if (metadata.status !== 'connected') throw new Error('Local model credential requires authentication.')
  const secret = await vault.load(metadata.id)
  if (metadata.provider === 'openai') {
    if (!secret.trim()) throw new Error('Stored OpenAI credential is invalid.')
    return { mode: 'api_key', apiKey: secret, oauthCredential: null, modelId: '' }
  }
  let credential: unknown
  try {
    credential = JSON.parse(secret)
  } catch {
    throw new Error('Stored ChatGPT credential is invalid.')
  }
  assertOAuthCredential(credential)
  return { mode: 'subscription', apiKey: '', oauthCredential: credential, modelId: '' }
}

function assertOAuthCredential(value: unknown): asserts value is CodexOAuthCredential {
  const credential = value as Partial<CodexOAuthCredential> | null
  if (!credential || credential.type !== 'oauth' || typeof credential.access !== 'string' || !credential.access
    || typeof credential.refresh !== 'string' || !credential.refresh || typeof credential.expires !== 'number'
    || !Number.isFinite(credential.expires) || typeof credential.accountId !== 'string' || !credential.accountId) {
    throw new Error('Stored ChatGPT credential is invalid.')
  }
}
