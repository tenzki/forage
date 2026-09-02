import { randomUUID } from 'node:crypto'
import { credentialMetadataSchema, deviceAuthorizationStartResponseSchema, deviceAuthorizationStatusSchema, type CredentialMetadata } from '@forage/protocol'
import { decryptSecret, encryptSecret, type EncryptedSecret, type EncryptionKey } from './credentialCrypto.js'

type Provider = 'openai-codex' | 'openai'
type Status = CredentialMetadata['status']

export interface ProviderCredentialRecord {
  id: string; ownerId: string; outlineId: string; provider: Provider; status: Status
  encrypted: EncryptedSecret | null; accountLabel?: string; expiresAt?: string
  createdAt: string; updatedAt: string
}

export interface ProviderCredentialStore {
  insert(record: ProviderCredentialRecord): Promise<void>
  get(id: string): Promise<ProviderCredentialRecord | null>
  mutate<T>(id: string, operation: (record: ProviderCredentialRecord) => Promise<{ record: ProviderCredentialRecord; result: T }>): Promise<T>
}

export class InMemoryProviderCredentialStore implements ProviderCredentialStore {
  private readonly records = new Map<string, ProviderCredentialRecord>()
  private readonly locks = new Map<string, Promise<void>>()

  async insert(record: ProviderCredentialRecord): Promise<void> {
    if (this.records.has(record.id)) throw new Error('Credential already exists.')
    this.records.set(record.id, structuredClone(record))
  }

  async get(id: string): Promise<ProviderCredentialRecord | null> {
    const record = this.records.get(id)
    return record ? structuredClone(record) : null
  }

  async mutate<T>(id: string, operation: (record: ProviderCredentialRecord) => Promise<{ record: ProviderCredentialRecord; result: T }>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => { release = resolve })
    const queued = previous.then(() => current)
    this.locks.set(id, queued)
    await previous
    try {
      const record = this.records.get(id)
      if (!record) throw new CredentialServiceError('authentication_required', 'Credential is unavailable.')
      const changed = await operation(structuredClone(record))
      this.records.set(id, structuredClone(changed.record))
      return changed.result
    } finally {
      release()
      if (this.locks.get(id) === queued) this.locks.delete(id)
    }
  }
}

export class CredentialServiceError extends Error {
  constructor(public readonly code: 'authentication_required' | 'provider_rejected' | 'authorization_expired', message: string) {
    super(message)
    this.name = 'CredentialServiceError'
  }
}

interface CodexSecret { kind: 'codex'; accessToken: string; refreshToken: string; accountId: string; expiresAt: string }
interface ApiKeySecret { kind: 'api_key'; apiKey: string }
interface DeviceSecret { kind: 'device'; deviceCode: string; expiresAt: string; pollIntervalSeconds: number }
type StoredSecret = CodexSecret | ApiKeySecret | DeviceSecret

export type ResolvedModelCredential =
  | { provider: 'openai'; apiKey: string }
  | { provider: 'openai-codex'; accessToken: string; accountId: string; expiresAt: string }

interface CredentialServiceOptions {
  encryptionKeys: EncryptionKey[]
  fetch?: typeof globalThis.fetch
  oauth?: { deviceUrl: string; tokenUrl: string; clientId: string }
}

export class ServerCredentialService {
  private readonly fetch: typeof globalThis.fetch

  constructor(private readonly store: ProviderCredentialStore, private readonly options: CredentialServiceOptions) {
    if (!options.encryptionKeys.length) throw new Error('At least one credential encryption key is required.')
    this.fetch = options.fetch ?? globalThis.fetch
  }

  async enrollApiKey(ownerId: string, outlineId: string, apiKey: string): Promise<CredentialMetadata> {
    if (apiKey.trim().length < 20) throw new CredentialServiceError('provider_rejected', 'OpenAI API key is invalid.')
    const now = new Date().toISOString()
    const record: ProviderCredentialRecord = {
      id: `credential_${randomUUID()}`, ownerId, outlineId, provider: 'openai', status: 'connected',
      encrypted: this.encrypt({ kind: 'api_key', apiKey: apiKey.trim() }), createdAt: now, updatedAt: now,
    }
    await this.store.insert(record)
    return metadata(record)
  }

  async startDeviceAuthorization(ownerId: string, outlineId: string) {
    const oauth = this.requireOauth()
    const response = await this.fetch(oauth.deviceUrl, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_id: oauth.clientId }),
    })
    const body = await responseJson(response)
    if (!response.ok) throw new CredentialServiceError('provider_rejected', 'Device authorization could not be started.')
    const deviceCode = requiredString(body, 'device_code')
    const userCode = requiredString(body, 'user_code')
    const verificationUri = requiredString(body, 'verification_uri')
    const expiresIn = boundedNumber(body, 'expires_in', 30, 1_800, 600)
    const pollIntervalSeconds = boundedNumber(body, 'interval', 1, 60, 5)
    const now = new Date()
    const expiresAt = new Date(now.getTime() + expiresIn * 1_000).toISOString()
    const record: ProviderCredentialRecord = {
      id: `credential_${randomUUID()}`, ownerId, outlineId, provider: 'openai-codex', status: 'pending',
      encrypted: this.encrypt({ kind: 'device', deviceCode, expiresAt, pollIntervalSeconds }),
      expiresAt, createdAt: now.toISOString(), updatedAt: now.toISOString(),
    }
    await this.store.insert(record)
    return deviceAuthorizationStartResponseSchema.parse({
      authorizationId: record.id, verificationUri, userCode, expiresAt, pollIntervalSeconds,
    })
  }

  async pollDeviceAuthorization(id: string, ownerId: string, outlineId: string) {
    return this.store.mutate(id, async (record) => {
      this.requireOwner(record, ownerId, outlineId)
      if (record.status === 'connected') return { record, result: deviceAuthorizationStatusSchema.parse({ state: 'connected', authorizationId: id, credential: metadata(record) }) }
      if (record.status !== 'pending' || !record.encrypted) return { record, result: deviceAuthorizationStatusSchema.parse({ state: 'failed', authorizationId: id }) }
      const secret = this.decrypt(record.encrypted)
      if (secret.kind !== 'device') throw new CredentialServiceError('provider_rejected', 'Credential state is invalid.')
      if (new Date(secret.expiresAt) <= new Date()) {
        const changed = { ...record, status: 'authentication_required' as const, encrypted: null, updatedAt: new Date().toISOString() }
        return { record: changed, result: deviceAuthorizationStatusSchema.parse({ state: 'expired', authorizationId: id }) }
      }
      const oauth = this.requireOauth()
      const response = await this.fetch(oauth.tokenUrl, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: oauth.clientId, device_code: secret.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
      })
      const body = await responseJson(response)
      const error = optionalString(body, 'error')
      if (!response.ok && (error === 'authorization_pending' || error === 'slow_down')) {
        return { record, result: deviceAuthorizationStatusSchema.parse({ state: 'pending', authorizationId: id }) }
      }
      if (!response.ok) {
        const state = error === 'access_denied' ? 'denied' as const : 'failed' as const
        const changed = { ...record, status: 'authentication_required' as const, encrypted: null, updatedAt: new Date().toISOString() }
        return { record: changed, result: deviceAuthorizationStatusSchema.parse({ state, authorizationId: id }) }
      }
      const codex = codexSecretFromToken(body)
      const changed: ProviderCredentialRecord = {
        ...record, status: 'connected', encrypted: this.encrypt(codex), accountLabel: codex.accountId,
        expiresAt: codex.expiresAt, updatedAt: new Date().toISOString(),
      }
      return { record: changed, result: deviceAuthorizationStatusSchema.parse({ state: 'connected', authorizationId: id, credential: metadata(changed) }) }
    })
  }

  async resolve(id: string, ownerId: string, outlineId: string): Promise<ResolvedModelCredential> {
    const outcome = await this.store.mutate<ResolutionOutcome>(id, async (record) => {
      this.requireOwner(record, ownerId, outlineId)
      if (record.status !== 'connected' || !record.encrypted) throw new CredentialServiceError('authentication_required', 'Provider authentication is required.')
      const secret = this.decrypt(record.encrypted)
      if (secret.kind === 'api_key') return { record, result: { credential: { provider: 'openai' as const, apiKey: secret.apiKey } } }
      if (secret.kind !== 'codex') throw new CredentialServiceError('authentication_required', 'Provider authentication is incomplete.')
      if (new Date(secret.expiresAt).getTime() > Date.now() + 60_000) {
        return { record, result: { credential: resolvedCodex(secret) } }
      }
      const oauth = this.requireOauth()
      const response = await this.fetch(oauth.tokenUrl, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: oauth.clientId, refresh_token: secret.refreshToken, grant_type: 'refresh_token' }),
      })
      const body = await responseJson(response)
      if (!response.ok) {
        const changed = { ...record, status: 'authentication_required' as const, encrypted: null, updatedAt: new Date().toISOString() }
        return { record: changed, result: { error: new CredentialServiceError('authentication_required', 'Provider authentication must be renewed.') } }
      }
      const refreshed = codexSecretFromToken(body, secret)
      const changed: ProviderCredentialRecord = {
        ...record, encrypted: this.encrypt(refreshed), accountLabel: refreshed.accountId,
        expiresAt: refreshed.expiresAt, updatedAt: new Date().toISOString(),
      }
      return { record: changed, result: { credential: resolvedCodex(refreshed) } }
    })
    if (outcome.error) throw outcome.error
    return outcome.credential!
  }

  async metadata(id: string, ownerId: string, outlineId: string): Promise<CredentialMetadata> {
    const record = await this.store.get(id)
    if (!record) throw new CredentialServiceError('authentication_required', 'Credential is unavailable.')
    this.requireOwner(record, ownerId, outlineId)
    return metadata(record)
  }

  async disconnect(id: string, ownerId: string, outlineId: string): Promise<CredentialMetadata> {
    return this.store.mutate(id, async (record) => {
      this.requireOwner(record, ownerId, outlineId)
      const changed = { ...record, status: 'disconnected' as const, encrypted: null, expiresAt: undefined, updatedAt: new Date().toISOString() }
      return { record: changed, result: metadata(changed) }
    })
  }

  async importCodexCredentialForTest(ownerId: string, outlineId: string, secret: Omit<CodexSecret, 'kind'>): Promise<string> {
    const now = new Date().toISOString()
    const record: ProviderCredentialRecord = {
      id: `credential_${randomUUID()}`, ownerId, outlineId, provider: 'openai-codex', status: 'connected',
      encrypted: this.encrypt({ kind: 'codex', ...secret }), accountLabel: secret.accountId, expiresAt: secret.expiresAt,
      createdAt: now, updatedAt: now,
    }
    await this.store.insert(record)
    return record.id
  }

  private encrypt(secret: StoredSecret): EncryptedSecret { return encryptSecret(JSON.stringify(secret), this.options.encryptionKeys[0]!) }
  private decrypt(encrypted: EncryptedSecret): StoredSecret { return JSON.parse(decryptSecret(encrypted, this.options.encryptionKeys)) as StoredSecret }
  private requireOauth() {
    if (!this.options.oauth) throw new CredentialServiceError('provider_rejected', 'ChatGPT device authorization is not configured.')
    return this.options.oauth
  }
  private requireOwner(record: ProviderCredentialRecord, ownerId: string, outlineId: string): void {
    if (record.ownerId !== ownerId || record.outlineId !== outlineId) throw new CredentialServiceError('authentication_required', 'Credential is unavailable.')
  }
}

interface ResolutionOutcome { credential?: ResolvedModelCredential; error?: CredentialServiceError }

function metadata(record: ProviderCredentialRecord): CredentialMetadata {
  return credentialMetadataSchema.parse({
    id: record.id, provider: record.provider, status: record.status,
    ...(record.accountLabel ? { accountLabel: record.accountLabel } : {}),
    ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
    createdAt: record.createdAt, updatedAt: record.updatedAt,
  })
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text()
  if (text.length > 100_000) return {}
  try { const value: unknown = JSON.parse(text); return value && typeof value === 'object' ? value as Record<string, unknown> : {} } catch { return {} }
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const result = optionalString(value, key)
  if (!result) throw new CredentialServiceError('provider_rejected', 'Authorization provider returned invalid data.')
  return result
}
function optionalString(value: Record<string, unknown>, key: string): string | null { return typeof value[key] === 'string' ? String(value[key]) : null }
function boundedNumber(value: Record<string, unknown>, key: string, minimum: number, maximum: number, fallback: number): number {
  const number = Number(value[key]); return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, Math.floor(number))) : fallback
}

function codexSecretFromToken(body: Record<string, unknown>, previous?: CodexSecret): CodexSecret {
  const accessToken = requiredString(body, 'access_token')
  const refreshToken = optionalString(body, 'refresh_token') ?? previous?.refreshToken
  if (!refreshToken) throw new CredentialServiceError('provider_rejected', 'Authorization provider omitted refresh credentials.')
  const accountId = accountIdFromJwt(accessToken) ?? previous?.accountId
  if (!accountId) throw new CredentialServiceError('provider_rejected', 'Authorization provider omitted account identity.')
  const expiresIn = boundedNumber(body, 'expires_in', 60, 86_400, 3_600)
  return { kind: 'codex', accessToken, refreshToken, accountId, expiresAt: new Date(Date.now() + expiresIn * 1_000).toISOString() }
}

function accountIdFromJwt(token: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>
    const auth = payload['https://api.openai.com/auth']
    if (auth && typeof auth === 'object' && typeof (auth as Record<string, unknown>).chatgpt_account_id === 'string') {
      return String((auth as Record<string, unknown>).chatgpt_account_id).slice(0, 300)
    }
    return typeof payload.account_id === 'string' ? payload.account_id.slice(0, 300) : null
  } catch { return null }
}

function resolvedCodex(secret: CodexSecret): ResolvedModelCredential {
  return { provider: 'openai-codex', accessToken: secret.accessToken, accountId: secret.accountId, expiresAt: secret.expiresAt }
}
