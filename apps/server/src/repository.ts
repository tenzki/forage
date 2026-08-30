import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  canonicalJson,
  createInitialOutlineState,
  parseEventEnvelope,
  reduceOutlineEvent,
  sha256Hex,
  type EventEnvelope,
  type OutlineState,
} from '@forage/domain'
import type { NotesCreateRequest, NotesCreateResponse } from '@forage/protocol'

export type TokenScope = 'notes:create' | 'sync'

export interface Principal {
  tokenId: string
  ownerId: string
  outlineId: string
  scopes: TokenScope[]
  kind: 'api' | 'device'
}

export interface BootstrapResult {
  ownerId: string
  outlineId: string
  inboxId: string
  apiToken: string
  deviceToken: string
}

export interface CreateNoteResult {
  response: NotesCreateResponse
  replayed: boolean
}

export interface AssetRecord {
  assetId: string
  ownerId: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp'
  byteSize: number
  storageKey: string | null
  completed: boolean
}

export class RepositoryError extends Error {
  constructor(
    public readonly code: 'authentication_required' | 'authorization_denied' | 'upgrade_required' | 'conflict' | 'idempotency_conflict',
    message: string,
  ) {
    super(message)
  }
}

export interface ServerRepository {
  readonly instanceId: string
  ready(): Promise<boolean>
  authenticate(secret: string, scope: TokenScope): Promise<Principal>
  currentRevision(outlineId: string): Promise<number>
  createNote(principal: Principal, key: string, input: NotesCreateRequest): Promise<CreateNoteResult>
  eventsAfter(outlineId: string, revision: number, limit: number): Promise<EventEnvelope[]>
  checkpoint(outlineId: string): Promise<{
    id: string; outlineId: string; documentVersion: number; schemaEpoch: number
    revision: number; integrityHash: string; state: OutlineState
  }>
  acceptEvents(principal: Principal, baseRevision: number, events: EventEnvelope[]): Promise<Array<{ eventId: string; revision: number }>>
  initiateAsset(principal: Principal, input: Omit<AssetRecord, 'ownerId' | 'storageKey' | 'completed'>): Promise<AssetRecord>
  completeAsset(principal: Principal, assetId: string, storageKey: string): Promise<AssetRecord>
  asset(principal: Principal, assetId: string): Promise<AssetRecord>
}

interface TokenRecord extends Principal {
  secretHash: string
  revokedAt: string | null
  expiresAt: string | null
  lastUsedAt: string | null
}

interface IdempotencyRecord {
  requestHash: string
  response: NotesCreateResponse
}

interface NoteProjection {
  id: string
  parentId: string | null
  text: string
  deleted: boolean
}

export class InMemoryServerRepository implements ServerRepository {
  readonly instanceId: string
  private ownerId = ''
  private outlineId = ''
  private inboxId = ''
  private revision = 0
  private state: OutlineState | null = null
  private readonly tokens = new Map<string, TokenRecord>()
  private readonly events: EventEnvelope[] = []
  private readonly notes = new Map<string, NoteProjection>()
  private readonly idempotency = new Map<string, IdempotencyRecord>()
  private readonly assets = new Map<string, AssetRecord>()

  constructor(options: { instanceId?: string } = {}) {
    this.instanceId = options.instanceId ?? `instance_${randomUUID()}`
  }

  async ready(): Promise<boolean> { return true }

  async bootstrapOwner(_email: string): Promise<BootstrapResult> {
    if (this.ownerId) throw new Error('The one-owner server is already bootstrapped.')
    this.ownerId = `owner_${randomUUID()}`
    this.outlineId = `outline_${randomUUID()}`
    this.inboxId = `note_${randomUUID()}`
    this.notes.set(this.inboxId, { id: this.inboxId, parentId: null, text: 'Inbox', deleted: false })
    this.state = createInitialOutlineState({
      type: 'doc',
      content: [{
        type: 'bulletList',
        content: [{
          type: 'listItem',
          attrs: { nodeId: this.inboxId, nodeType: 'user', collapsed: false, bulletKind: 'bullet', completed: false },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Inbox' }] }],
        }],
      }],
    })
    const apiToken = this.issueToken('api', ['notes:create'])
    const deviceToken = this.issueToken('device', ['sync'])
    return { ownerId: this.ownerId, outlineId: this.outlineId, inboxId: this.inboxId, apiToken, deviceToken }
  }

  private issueToken(kind: 'api' | 'device', scopes: TokenScope[]): string {
    const secret = `fg_${kind}_${randomBytes(32).toString('base64url')}`
    const tokenId = `token_${randomUUID()}`
    this.tokens.set(hashSecret(secret), {
      tokenId, ownerId: this.ownerId, outlineId: this.outlineId, scopes, kind,
      secretHash: hashSecret(secret), revokedAt: null, expiresAt: null, lastUsedAt: null,
    })
    return secret
  }

  async authenticate(secret: string, scope: TokenScope): Promise<Principal> {
    const record = this.tokens.get(hashSecret(secret))
    const now = new Date()
    if (!record || record.revokedAt || (record.expiresAt && new Date(record.expiresAt) <= now)) {
      throw new RepositoryError('authentication_required', 'Authentication is required.')
    }
    if (!record.scopes.includes(scope)) {
      throw new RepositoryError('authorization_denied', 'The token does not have the required scope.')
    }
    record.lastUsedAt = now.toISOString()
    return { tokenId: record.tokenId, ownerId: record.ownerId, outlineId: record.outlineId, scopes: [...record.scopes], kind: record.kind }
  }

  async currentRevision(outlineId: string): Promise<number> {
    this.requireOutline(outlineId)
    return this.revision
  }

  async createNote(principal: Principal, key: string, input: NotesCreateRequest): Promise<CreateNoteResult> {
    this.requireOutline(principal.outlineId)
    const requestHash = await sha256Hex(canonicalJson(input))
    const recordKey = `${principal.tokenId}:${key}`
    const existing = this.idempotency.get(recordKey)
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new RepositoryError('idempotency_conflict', 'The idempotency key was already used with different input.')
      }
      return { response: structuredClone(existing.response), replayed: true }
    }
    const parentId = input.parentId ?? this.inboxId
    const parent = this.notes.get(parentId)
    if (!parent || parent.deleted) throw new RepositoryError('conflict', 'The requested parent does not exist or is deleted.')

    const noteId = `note_${randomUUID()}`
    const eventId = `event_${randomUUID()}`
    const createdAt = new Date().toISOString()
    const event = parseEventEnvelope({
      id: eventId, outlineId: principal.outlineId, actorId: principal.ownerId,
      deviceId: `api_${principal.tokenId}`, type: 'note.created', eventVersion: 1,
      documentVersion: 1, schemaEpoch: 1, baseRevision: this.revision,
      revision: this.revision + 1, origin: 'notes_api', occurredAt: createdAt,
      payload: { noteId, parentId, text: input.text, source: input.source, clientCreatedAt: input.clientCreatedAt },
    })
    this.revision += 1
    this.events.push(event)
    this.state = reduceOutlineEvent(this.state!, event)
    this.notes.set(noteId, { id: noteId, parentId, text: input.text, deleted: false })
    const response: NotesCreateResponse = { noteId, eventId, revision: this.revision, parentId, origin: 'notes_api', createdAt }
    this.idempotency.set(recordKey, { requestHash, response: structuredClone(response) })
    return { response, replayed: false }
  }

  async eventsAfter(outlineId: string, revision: number, limit: number): Promise<EventEnvelope[]> {
    this.requireOutline(outlineId)
    return this.events.filter((event) => (event.revision ?? 0) > revision).slice(0, limit).map((event) => structuredClone(event))
  }

  async checkpoint(outlineId: string) {
    this.requireOutline(outlineId)
    const state = structuredClone(this.state!)
    return {
      id: `checkpoint_${randomUUID()}`, outlineId, documentVersion: 1, schemaEpoch: 1,
      revision: this.revision, integrityHash: await sha256Hex(canonicalJson(state)), state,
    }
  }

  async acceptEvents(principal: Principal, baseRevision: number, events: EventEnvelope[]) {
    this.requireOutline(principal.outlineId)
    if (baseRevision !== this.revision) throw new RepositoryError('conflict', 'rebase_required')
    const acknowledgements: Array<{ eventId: string; revision: number }> = []
    for (const candidate of events) {
      const duplicate = this.events.find((event) => event.id === candidate.id)
      if (duplicate) {
        if (!sameEventContent(duplicate, candidate)) {
          throw new RepositoryError('conflict', `Event id ${candidate.id} was reused with different content.`)
        }
        acknowledgements.push({ eventId: duplicate.id, revision: duplicate.revision! })
        continue
      }
      requireCompatibleEvent(candidate)
      this.requireCompletedAssets(principal, candidate)
      this.revision += 1
      const accepted = parseEventEnvelope({
        ...candidate, outlineId: principal.outlineId, baseRevision: this.revision - 1, revision: this.revision,
      })
      this.events.push(accepted)
      this.state = reduceOutlineEvent(this.state!, accepted)
      acknowledgements.push({ eventId: accepted.id, revision: this.revision })
    }
    return acknowledgements
  }

  async initiateAsset(
    principal: Principal,
    input: Omit<AssetRecord, 'ownerId' | 'storageKey' | 'completed'>,
  ): Promise<AssetRecord> {
    this.requireOutline(principal.outlineId)
    const existing = this.assets.get(input.assetId)
    if (existing) {
      if (existing.ownerId !== principal.ownerId) throw hiddenAssetError()
      if (existing.mediaType !== input.mediaType || existing.byteSize !== input.byteSize) {
        throw new RepositoryError('conflict', 'Asset metadata does not match the existing upload.')
      }
      return structuredClone(existing)
    }
    const record: AssetRecord = { ...input, ownerId: principal.ownerId, storageKey: null, completed: false }
    this.assets.set(input.assetId, record)
    return structuredClone(record)
  }

  async completeAsset(principal: Principal, assetId: string, storageKey: string): Promise<AssetRecord> {
    const record = this.assets.get(assetId)
    if (!record || record.ownerId !== principal.ownerId) throw hiddenAssetError()
    record.storageKey = storageKey
    record.completed = true
    return structuredClone(record)
  }

  async asset(principal: Principal, assetId: string): Promise<AssetRecord> {
    const record = this.assets.get(assetId)
    if (!record || record.ownerId !== principal.ownerId || !record.completed) throw hiddenAssetError()
    return structuredClone(record)
  }

  private requireCompletedAssets(principal: Principal, event: EventEnvelope): void {
    for (const assetId of referencedAssetIds(event.payload)) {
      const record = this.assets.get(assetId)
      if (!record || !record.completed || record.ownerId !== principal.ownerId) {
        throw new RepositoryError('conflict', 'The event references an unavailable asset.')
      }
    }
  }

  private requireOutline(outlineId: string): void {
    if (!this.outlineId || outlineId !== this.outlineId) {
      throw new RepositoryError('authorization_denied', 'The requested resource is unavailable.')
    }
  }
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

export function referencedAssetIds(value: unknown): string[] {
  const found = new Set<string>()
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) return candidate.forEach(visit)
    if (!candidate || typeof candidate !== 'object') return
    for (const [key, child] of Object.entries(candidate)) {
      if (key === 'assetId' && typeof child === 'string') found.add(child)
      else visit(child)
    }
  }
  visit(value)
  return [...found]
}

function hiddenAssetError(): RepositoryError {
  return new RepositoryError('authorization_denied', 'The requested resource is unavailable.')
}

export function requireCompatibleEvent(event: EventEnvelope, documentVersion = 1, schemaEpoch = 1): void {
  if (event.eventVersion !== 1 || event.documentVersion !== documentVersion || event.schemaEpoch !== schemaEpoch) {
    throw new RepositoryError('upgrade_required', 'The event or document version is not supported by this server.')
  }
}

export function sameEventContent(left: EventEnvelope, right: EventEnvelope): boolean {
  const content = (event: EventEnvelope) => canonicalJson({
    id: event.id, outlineId: event.outlineId, actorId: event.actorId, deviceId: event.deviceId,
    type: event.type, eventVersion: event.eventVersion, documentVersion: event.documentVersion,
    schemaEpoch: event.schemaEpoch, origin: event.origin, occurredAt: event.occurredAt,
    changeGroupId: event.changeGroupId, payload: event.payload,
  })
  return content(left) === content(right)
}
