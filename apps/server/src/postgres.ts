import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Pool, PoolClient, QueryResultRow } from 'pg'
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
import {
  RepositoryError,
  referencedAssetIds,
  requireCompatibleEvent,
  sameEventContent,
  type BootstrapResult,
  type AssetRecord,
  type CreateNoteResult,
  type Principal,
  type ServerRepository,
  type TokenScope,
} from './repository.js'

export class PostgresServerRepository implements ServerRepository {
  readonly instanceId: string

  constructor(
    private readonly pool: Pool,
    options: { instanceId: string },
  ) {
    this.instanceId = options.instanceId
  }

  async ready(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1')
      return true
    } catch {
      return false
    }
  }

  async bootstrapOwner(email: string): Promise<BootstrapResult> {
    return this.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [0x464f5241])
      const existing = await client.query('SELECT id FROM owners LIMIT 1')
      if (existing.rowCount) throw new Error('The one-owner server is already bootstrapped.')

      const ownerId = `owner_${randomUUID()}`
      const outlineId = `outline_${randomUUID()}`
      const inboxId = `note_${randomUUID()}`
      const now = new Date().toISOString()
      const state = createInitialOutlineState({
        type: 'doc',
        content: [{
          type: 'bulletList',
          content: [{
            type: 'listItem',
            attrs: { nodeId: inboxId, nodeType: 'user', collapsed: false, bulletKind: 'bullet', completed: false },
            content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Inbox' }] }],
          }],
        }],
      })
      const checkpointId = `checkpoint_${randomUUID()}`
      const integrityHash = await sha256Hex(canonicalJson(state))

      await client.query('INSERT INTO owners(id, email) VALUES ($1, $2)', [ownerId, email])
      await client.query(
        `INSERT INTO outlines(id, owner_id, name, api_inbox_id) VALUES ($1, $2, 'Notes', $3)`,
        [outlineId, ownerId, inboxId],
      )
      await client.query(
        `INSERT INTO note_projections(outline_id, id, parent_id, text_content, created_at)
         VALUES ($1, $2, NULL, 'Inbox', $3)`,
        [outlineId, inboxId, now],
      )
      await client.query(
        `INSERT INTO outline_projections(outline_id, revision, state) VALUES ($1, 0, $2)`,
        [outlineId, state],
      )
      await client.query(
        `INSERT INTO outline_checkpoints
         (id, outline_id, revision, document_version, schema_epoch, state, integrity_hash)
         VALUES ($1, $2, 0, 1, 1, $3, $4)`,
        [checkpointId, outlineId, state, integrityHash],
      )
      const apiToken = await this.issueToken(client, ownerId, outlineId, 'api', 'External note capture', ['notes:create'])
      const deviceToken = await this.issueToken(client, ownerId, outlineId, 'device', 'Initial desktop', ['sync'])
      return { ownerId, outlineId, inboxId, apiToken, deviceToken }
    })
  }

  private async issueToken(
    client: PoolClient,
    ownerId: string,
    outlineId: string,
    kind: 'api' | 'device',
    name: string,
    scopes: TokenScope[],
  ): Promise<string> {
    const secret = `fg_${kind}_${randomBytes(32).toString('base64url')}`
    await client.query(
      `INSERT INTO credentials(id, owner_id, outline_id, kind, name, secret_hash, scopes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [`token_${randomUUID()}`, ownerId, outlineId, kind, name, hashSecret(secret), scopes],
    )
    return secret
  }

  async authenticate(secret: string, scope: TokenScope): Promise<Principal> {
    const result = await this.pool.query<CredentialRow>(
      `UPDATE credentials SET last_used_at = now()
       WHERE secret_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
       RETURNING id, owner_id, outline_id, kind, scopes`,
      [hashSecret(secret)],
    )
    const row = result.rows[0]
    if (!row) throw new RepositoryError('authentication_required', 'Authentication is required.')
    if (!row.scopes.includes(scope)) {
      throw new RepositoryError('authorization_denied', 'The token does not have the required scope.')
    }
    return {
      tokenId: row.id, ownerId: row.owner_id, outlineId: row.outline_id,
      kind: row.kind, scopes: row.scopes,
    }
  }

  async currentRevision(outlineId: string): Promise<number> {
    const result = await this.pool.query<{ current_revision: string }>(
      'SELECT current_revision FROM outlines WHERE id = $1', [outlineId],
    )
    if (!result.rows[0]) throw hiddenResourceError()
    return Number(result.rows[0].current_revision)
  }

  async createNote(principal: Principal, key: string, input: NotesCreateRequest): Promise<CreateNoteResult> {
    return this.transaction(async (client) => {
      await this.recheckCredential(client, principal)
      const outline = await client.query<{ current_revision: string; api_inbox_id: string }>(
        'SELECT current_revision, api_inbox_id FROM outlines WHERE id = $1 FOR UPDATE', [principal.outlineId],
      )
      const row = outline.rows[0]
      if (!row) throw hiddenResourceError()
      const requestHash = await sha256Hex(canonicalJson(input))
      const previous = await client.query<{ request_hash: string; response: NotesCreateResponse }>(
        `SELECT request_hash, response FROM idempotency_records
         WHERE credential_id = $1 AND key = $2 FOR UPDATE`,
        [principal.tokenId, key],
      )
      if (previous.rows[0]) {
        if (previous.rows[0].request_hash !== requestHash) {
          throw new RepositoryError('idempotency_conflict', 'The idempotency key was already used with different input.')
        }
        return { response: previous.rows[0].response, replayed: true }
      }

      const parentId = input.parentId ?? row.api_inbox_id
      const parent = await client.query(
        `SELECT id FROM note_projections WHERE outline_id = $1 AND id = $2 AND deleted = false`,
        [principal.outlineId, parentId],
      )
      if (!parent.rowCount) throw new RepositoryError('conflict', 'The requested parent does not exist or is deleted.')

      const revision = Number(row.current_revision) + 1
      const noteId = `note_${randomUUID()}`
      const eventId = `event_${randomUUID()}`
      const createdAt = new Date().toISOString()
      const event = parseEventEnvelope({
        id: eventId, outlineId: principal.outlineId, actorId: principal.ownerId,
        deviceId: `api_${principal.tokenId}`, type: 'note.created', eventVersion: 1,
        documentVersion: 1, schemaEpoch: 1, baseRevision: revision - 1, revision,
        origin: 'notes_api', occurredAt: createdAt,
        payload: { noteId, parentId, text: input.text, source: input.source, clientCreatedAt: input.clientCreatedAt },
      })
      await this.insertEvent(client, event)
      await client.query(
        `INSERT INTO note_projections(outline_id, id, parent_id, text_content, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [principal.outlineId, noteId, parentId, input.text, createdAt],
      )
      await this.applyProjection(client, principal.outlineId, revision, event)
      await client.query('UPDATE outlines SET current_revision = $2 WHERE id = $1', [principal.outlineId, revision])
      const response: NotesCreateResponse = { noteId, eventId, revision, parentId, origin: 'notes_api', createdAt }
      await client.query(
        `INSERT INTO idempotency_records(credential_id, key, request_hash, response)
         VALUES ($1, $2, $3, $4)`,
        [principal.tokenId, key, requestHash, response],
      )
      return { response, replayed: false }
    })
  }

  async eventsAfter(outlineId: string, revision: number, limit: number): Promise<EventEnvelope[]> {
    const result = await this.pool.query<EventRow>(
      `SELECT * FROM outline_events WHERE outline_id = $1 AND revision > $2
       ORDER BY revision ASC LIMIT $3`,
      [outlineId, revision, limit],
    )
    return result.rows.map(eventFromRow)
  }

  async checkpoint(outlineId: string) {
    const result = await this.pool.query<{ revision: string; state: OutlineState; document_version: number; schema_epoch: number }>(
      `SELECT p.revision, p.state, o.document_version, o.schema_epoch
       FROM outline_projections p JOIN outlines o ON o.id = p.outline_id WHERE p.outline_id = $1`,
      [outlineId],
    )
    const row = result.rows[0]
    if (!row) throw hiddenResourceError()
    const checkpoint = {
      id: `checkpoint_${randomUUID()}`, outlineId, revision: Number(row.revision),
      documentVersion: row.document_version, schemaEpoch: row.schema_epoch,
      integrityHash: await sha256Hex(canonicalJson(row.state)), state: row.state,
    }
    await this.pool.query(
      `INSERT INTO outline_checkpoints
       (id, outline_id, revision, document_version, schema_epoch, state, integrity_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (outline_id, revision, schema_epoch) DO NOTHING`,
      [checkpoint.id, outlineId, checkpoint.revision, checkpoint.documentVersion,
        checkpoint.schemaEpoch, checkpoint.state, checkpoint.integrityHash],
    )
    return checkpoint
  }

  async acceptEvents(principal: Principal, baseRevision: number, events: EventEnvelope[]) {
    return this.transaction(async (client) => {
      await this.recheckCredential(client, principal)
      const outline = await client.query<{ current_revision: string; document_version: number; schema_epoch: number }>(
        'SELECT current_revision, document_version, schema_epoch FROM outlines WHERE id = $1 FOR UPDATE', [principal.outlineId],
      )
      const currentRevision = Number(outline.rows[0]?.current_revision ?? -1)
      if (currentRevision < 0) throw hiddenResourceError()

      if (events.length > 0) {
        const existing = await client.query<EventRow>(
          'SELECT * FROM outline_events WHERE id = ANY($1::text[])',
          [events.map((event) => event.id)],
        )
        if (existing.rowCount === events.length) {
          const accepted = new Map(existing.rows.map((row) => [row.id, eventFromRow(row)]))
          return events.map((event) => {
            const duplicate = accepted.get(event.id)!
            if (!sameEventContent(duplicate, event)) {
              throw new RepositoryError('conflict', `Event id ${event.id} was reused with different content.`)
            }
            return { eventId: event.id, revision: duplicate.revision! }
          })
        }
      }
      if (baseRevision !== currentRevision) throw new RepositoryError('conflict', 'rebase_required')

      let revision = currentRevision
      const acknowledgements: Array<{ eventId: string; revision: number }> = []
      for (const candidate of events) {
        if (candidate.outlineId !== principal.outlineId) throw hiddenResourceError()
        requireCompatibleEvent(candidate, outline.rows[0].document_version, outline.rows[0].schema_epoch)
        await this.requireCompletedAssets(client, principal, candidate)
        revision += 1
        const accepted = parseEventEnvelope({ ...candidate, baseRevision: revision - 1, revision })
        await this.insertEvent(client, accepted)
        await this.applyProjection(client, principal.outlineId, revision, accepted)
        acknowledgements.push({ eventId: accepted.id, revision })
      }
      await client.query('UPDATE outlines SET current_revision = $2 WHERE id = $1', [principal.outlineId, revision])
      return acknowledgements
    })
  }

  async initiateAsset(
    principal: Principal,
    input: Omit<AssetRecord, 'ownerId' | 'storageKey' | 'completed'>,
  ): Promise<AssetRecord> {
    const result = await this.pool.query<AssetRow>(
      `INSERT INTO assets(asset_id, owner_id, media_type, byte_size, storage_key)
       VALUES ($1, $2, $3, $4, $1)
       ON CONFLICT (asset_id) DO UPDATE SET asset_id = assets.asset_id
       RETURNING asset_id, owner_id, media_type, byte_size, storage_key, completed_at`,
      [input.assetId, principal.ownerId, input.mediaType, input.byteSize],
    )
    const record = assetFromRow(result.rows[0])
    if (record.ownerId !== principal.ownerId) throw hiddenResourceError()
    if (record.mediaType !== input.mediaType || record.byteSize !== input.byteSize) {
      throw new RepositoryError('conflict', 'Asset metadata does not match the existing upload.')
    }
    return record
  }

  async completeAsset(principal: Principal, assetId: string, storageKey: string): Promise<AssetRecord> {
    const result = await this.pool.query<AssetRow>(
      `UPDATE assets SET storage_key = $3, completed_at = COALESCE(completed_at, now())
       WHERE asset_id = $1 AND owner_id = $2
       RETURNING asset_id, owner_id, media_type, byte_size, storage_key, completed_at`,
      [assetId, principal.ownerId, storageKey],
    )
    if (!result.rows[0]) throw hiddenResourceError()
    return assetFromRow(result.rows[0])
  }

  async asset(principal: Principal, assetId: string): Promise<AssetRecord> {
    const result = await this.pool.query<AssetRow>(
      `SELECT asset_id, owner_id, media_type, byte_size, storage_key, completed_at
       FROM assets WHERE asset_id = $1 AND owner_id = $2 AND completed_at IS NOT NULL`,
      [assetId, principal.ownerId],
    )
    if (!result.rows[0]) throw hiddenResourceError()
    return assetFromRow(result.rows[0])
  }

  private async requireCompletedAssets(client: PoolClient, principal: Principal, event: EventEnvelope): Promise<void> {
    const ids = referencedAssetIds(event.payload)
    if (ids.length === 0) return
    const result = await client.query<{ asset_id: string }>(
      `SELECT asset_id FROM assets WHERE owner_id = $1 AND completed_at IS NOT NULL
       AND asset_id = ANY($2::text[])`,
      [principal.ownerId, ids],
    )
    if (result.rowCount !== ids.length) throw new RepositoryError('conflict', 'The event references an unavailable asset.')
  }

  private async recheckCredential(client: PoolClient, principal: Principal): Promise<void> {
    const result = await client.query(
      `SELECT id FROM credentials WHERE id = $1 AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > now()) FOR SHARE`,
      [principal.tokenId],
    )
    if (!result.rowCount) throw new RepositoryError('authentication_required', 'Authentication is required.')
  }

  private async insertEvent(client: PoolClient, event: EventEnvelope): Promise<void> {
    await client.query(
      `INSERT INTO outline_events
       (id, outline_id, revision, base_revision, event_type, event_version, document_version,
        schema_epoch, actor_id, device_id, origin, change_group_id, payload, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [event.id, event.outlineId, event.revision, event.baseRevision, event.type, event.eventVersion,
        event.documentVersion, event.schemaEpoch, event.actorId, event.deviceId, event.origin,
        event.changeGroupId ?? null, event.payload, event.occurredAt],
    )
  }

  private async applyProjection(client: PoolClient, outlineId: string, revision: number, event: EventEnvelope): Promise<void> {
    const projection = await client.query<{ state: OutlineState }>(
      'SELECT state FROM outline_projections WHERE outline_id = $1 FOR UPDATE', [outlineId],
    )
    const state = projection.rows[0]?.state
    if (!state) throw new Error('Outline projection is missing.')
    const next = reduceOutlineEvent(state, event)
    await client.query(
      `UPDATE outline_projections SET revision = $2, state = $3, updated_at = now() WHERE outline_id = $1`,
      [outlineId, revision, next],
    )
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await operation(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
}

interface CredentialRow extends QueryResultRow {
  id: string
  owner_id: string
  outline_id: string
  kind: 'api' | 'device'
  scopes: TokenScope[]
}

interface EventRow extends QueryResultRow {
  id: string; outline_id: string; revision: string; base_revision: string; event_type: string
  event_version: number; document_version: number; schema_epoch: number; actor_id: string
  device_id: string; origin: EventEnvelope['origin']; change_group_id: string | null
  payload: Record<string, unknown>; occurred_at: Date
}

interface AssetRow extends QueryResultRow {
  asset_id: string
  owner_id: string
  media_type: AssetRecord['mediaType']
  byte_size: string
  storage_key: string
  completed_at: Date | null
}

function assetFromRow(row: AssetRow): AssetRecord {
  return {
    assetId: row.asset_id,
    ownerId: row.owner_id,
    mediaType: row.media_type,
    byteSize: Number(row.byte_size),
    storageKey: row.storage_key,
    completed: row.completed_at !== null,
  }
}

function eventFromRow(row: EventRow): EventEnvelope {
  return parseEventEnvelope({
    id: row.id, outlineId: row.outline_id, revision: Number(row.revision),
    baseRevision: Number(row.base_revision), type: row.event_type,
    eventVersion: row.event_version, documentVersion: row.document_version,
    schemaEpoch: row.schema_epoch, actorId: row.actor_id, deviceId: row.device_id,
    origin: row.origin, changeGroupId: row.change_group_id ?? undefined,
    payload: row.payload, occurredAt: row.occurred_at.toISOString(),
  })
}

function hiddenResourceError(): RepositoryError {
  return new RepositoryError('authorization_denied', 'The requested resource is unavailable.')
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}
