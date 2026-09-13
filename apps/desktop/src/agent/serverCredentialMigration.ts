import type { CredentialMetadata } from '@forage/protocol'
import type { CodexAuthMode } from '../store/settingsStore'
import {
  nativeLocalCredentialVault,
  resolveLocalCredential,
  type LocalCredentialMetadata,
} from './localCredentials'

interface CredentialImportTransport {
  importCredential(request: unknown): Promise<CredentialMetadata>
}

export async function migrateSelectedDesktopCredential(
  transport: CredentialImportTransport,
  authMode: CodexAuthMode,
  localCredentials: LocalCredentialMetadata[],
): Promise<CredentialMetadata | null> {
  const provider = authMode === 'subscription' ? 'openai-codex' : 'openai'
  const metadata = localCredentials.find((candidate) => (
    candidate.provider === provider && candidate.status === 'connected'
  ))
  if (!metadata) return null

  const resolved = await resolveLocalCredential(metadata, nativeLocalCredentialVault)
  if (resolved.mode === 'api_key') {
    return transport.importCredential({ provider: 'openai', apiKey: resolved.apiKey })
  }
  const oauth = resolved.oauthCredential!
  return transport.importCredential({
    provider: 'openai-codex',
    accessToken: oauth.access,
    refreshToken: oauth.refresh,
    accountId: oauth.accountId,
    expiresAt: new Date(oauth.expires).toISOString(),
  })
}
