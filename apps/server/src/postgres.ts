import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Pool, PoolClient, QueryResultRow } from 'pg'
import {
  canonicalJson,
  parseEventEnvelope,
  reduceOutlineEvent,
  sha256Hex,
  type EventEnvelope,
  type OutlineState,
} from '@forage/domain'
import type { NotesCreateRequest, NotesCreateResponse } from '@forage/protocol'
import { createOutlineSchema, findSystemNode, queryCanonicalOutline } from '@forage/document'
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
  type DispatcherAgentContext,
  type TokenScope,
  noteProjectionsFromState,
  NOTE_PROJECTOR_SCHEMA_VERSION,
  type BoundPrincipal,
} from './repository.js'
import { PostgresAgentStore } from './postgresAgentStore.js'
import { portableAgentConfigurationSchema, parseStructuredResult, resolveEffectiveToolIds, runInputSchema, type RunInput, type StructuredResult } from '@forage/agent-runtime'
import { automationPolicySetSchema } from '@forage/protocol'
import { captureFacts, resolveAutomationMatches, type DispatcherClassifier } from './automation.js'

export class PostgresServerRepository implements ServerRepository {
  readonly instanceId: string
  readonly agentStore: PostgresAgentStore
  private readonly supportedAgentToolIds: string[]
  private readonly agentMaxAttempts: number
  private readonly dispatcherForAgent?: (context: DispatcherAgentContext) => Promise<DispatcherClassifier | undefined>

  constructor(
    private readonly pool: Pool,
    options: {
      instanceId: string; supportedAgentToolIds?: string[]; agentMaxAttempts?: number
      dispatcherForAgent?: (context: DispatcherAgentContext) => Promise<DispatcherClassifier | undefined>
    },
  ) {
    this.instanceId = options.instanceId
    this.agentStore = new PostgresAgentStore(pool)
    this.supportedAgentToolIds = options.supportedAgentToolIds ?? []
    this.agentMaxAttempts = options.agentMaxAttempts ?? 3
    this.dispatcherForAgent = options.dispatcherForAgent
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
      await client.query('INSERT INTO owners(id, email) VALUES ($1, $2)', [ownerId, email])
      const apiToken = await this.issueToken(client, ownerId, null, 'api', 'External note capture', ['notes:create'])
      const deviceToken = await this.issueToken(
        client, ownerId, null, 'device', 'Initial desktop',
        ['sync', 'agents:read', 'agents:execute', 'agents:manage'],
      )
      return { ownerId, apiToken, deviceToken }
    })
  }

  async claimOutline(
    principal: Principal,
    input: { outlineId: string; name: string },
  ): Promise<{ outlineId: string; state: 'seeding' | 'ready' }> {
    return this.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [0x464f5242])
      const existing = await client.query<{ id: string; state: 'seeding' | 'ready' }>(
        'SELECT id, state FROM outlines WHERE owner_id = $1', [principal.ownerId],
      )
      const current = existing.rows[0]
      if (current) {
        if (current.id !== input.outlineId || principal.outlineId !== current.id) {
          throw new RepositoryError('conflict', 'This server already holds an outline.')
        }
        return { outlineId: current.id, state: current.state }
      }
      await client.query(
        `INSERT INTO outlines(id, owner_id, name, api_inbox_id, state) VALUES ($1, $2, $3, NULL, 'seeding')`,
        [input.outlineId, principal.ownerId, input.name],
      )
      // Every credential the owner already holds attaches to the outline they have just
      // claimed. Binding only the claiming device would strand the capture token forever.
      await client.query(
        'UPDATE credentials SET outline_id = $2 WHERE owner_id = $1 AND outline_id IS NULL',
        [principal.ownerId, input.outlineId],
      )
      return { outlineId: input.outlineId, state: 'seeding' as const }
    })
  }

  async outlineState(outlineId: string): Promise<'seeding' | 'ready'> {
    const result = await this.pool.query<{ state: 'seeding' | 'ready' }>(
      'SELECT state FROM outlines WHERE id = $1', [outlineId],
    )
    if (!result.rows[0]) throw hiddenResourceError()
    return result.rows[0].state
  }

  async seedOutline(
    principal: BoundPrincipal,
    state: OutlineState,
  ): Promise<{ outlineId: string; revision: number; integrityHash: string }> {
    const outlineId = principal.outlineId
    const integrityHash = await sha256Hex(canonicalJson(state))
    return this.transaction(async (client) => {
      const outline = await client.query<{ state: 'seeding' | 'ready'; document_version: number }>(
        'SELECT state, document_version FROM outlines WHERE id = $1 AND owner_id = $2 FOR UPDATE',
        [outlineId, principal.ownerId],
      )
      if (!outline.rows[0]) throw hiddenResourceError()
      if (outline.rows[0].state === 'ready') {
        const existing = await client.query<{ integrity_hash: string }>(
          'SELECT integrity_hash FROM outline_checkpoints WHERE outline_id = $1 AND revision = 0',
          [outlineId],
        )
        if (existing.rows[0]?.integrity_hash === integrityHash) {
          return { outlineId, revision: 0, integrityHash }
        }
        throw new RepositoryError('conflict', 'This outline has already been seeded.')
      }

      const referenced = [...referencedAssetIds(state)]
      if (referenced.length) {
        const complete = await client.query<{ asset_id: string }>(
          'SELECT asset_id FROM assets WHERE owner_id = $1 AND completed_at IS NOT NULL AND asset_id = ANY($2::text[])',
          [principal.ownerId, referenced],
        )
        const uploaded = new Set(complete.rows.map((row) => row.asset_id))
        const missing = referenced.filter((assetId) => !uploaded.has(assetId))
        if (missing.length) {
          throw new RepositoryError('conflict', `The seed references assets that are not uploaded: ${missing.join(', ')}`)
        }
      }

      const inbox = findSystemNode(createOutlineSchema().nodeFromJSON(state.doc), 'inbox')
      if (!inbox) throw new RepositoryError('conflict', 'The seed document has no Inbox node.')

      await client.query(
        'INSERT INTO outline_projections(outline_id, revision, state) VALUES ($1, 0, $2)',
        [outlineId, state],
      )
      await client.query(
        `INSERT INTO outline_checkpoints
         (id, outline_id, revision, document_version, schema_epoch, state, integrity_hash)
         VALUES ($1, $2, 0, $3, $4, $5, $6)`,
        [`checkpoint_${randomUUID()}`, outlineId, outline.rows[0].document_version, state.schemaEpoch, state, integrityHash],
      )
      await client.query(
        `UPDATE outlines SET state = 'ready', api_inbox_id = $2, schema_epoch = $3 WHERE id = $1`,
        [outlineId, inbox.id, state.schemaEpoch],
      )
      await this.rebuildNoteIndex(client, outlineId, state, 0)
      return { outlineId, revision: 0, integrityHash }
    })
  }

  private async issueToken(
    client: PoolClient,
    ownerId: string,
    outlineId: string | null,
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

  async createNote(principal: BoundPrincipal, key: string, input: NotesCreateRequest): Promise<CreateNoteResult> {
    return this.transaction(async (client) => {
      await this.recheckCredential(client, principal)
      const outline = await client.query<{ current_revision: string }>(
        'SELECT current_revision FROM outlines WHERE id = $1 FOR UPDATE', [principal.outlineId],
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

      const canonicalProjection = await this.canonicalProjection(client, principal.outlineId, true)
      const inbox = findSystemNode(createOutlineSchema().nodeFromJSON(canonicalProjection.state.doc), 'inbox')
      if (!inbox) throw new RepositoryError('conflict', 'The canonical Inbox is unavailable.')
      const parentId = input.parentId ?? inbox.id
      requireLiveCanonicalNode(queryCanonicalOutline(canonicalProjection.state), parentId, 'target')

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
      await this.applyProjection(client, principal.outlineId, revision, event)
      await client.query('UPDATE outlines SET current_revision = $2 WHERE id = $1', [principal.outlineId, revision])
      const latest = await this.canonicalProjection(client, principal.outlineId, true)
      await this.rebuildNoteIndex(client, principal.outlineId, latest.state, revision)
      const response: NotesCreateResponse = { noteId, eventId, revision, parentId, origin: 'notes_api', createdAt }
      await client.query(
        `INSERT INTO idempotency_records(credential_id, key, request_hash, response)
         VALUES ($1, $2, $3, $4)`,
        [principal.tokenId, key, requestHash, response],
      )
      if (parentId === inbox.id) await this.admitAutomaticRuns(client, principal, noteId, input, revision)
      return { response, replayed: false }
    })
  }

  private async admitAutomaticRuns(
    client: PoolClient, principal: BoundPrincipal, noteId: string, capture: NotesCreateRequest, baseRevision: number,
  ): Promise<void> {
    const configurationResult = await client.query<{ configuration: unknown }>(
        'SELECT configuration FROM agent_configuration_revisions WHERE outline_id=$1 ORDER BY revision DESC LIMIT 1', [principal.outlineId],
      )
    const automationResult = await client.query<{ policies: unknown }>(
        'SELECT policies FROM agent_automation_revisions WHERE outline_id=$1 ORDER BY revision DESC LIMIT 1', [principal.outlineId],
      )
    const computeResult = await client.query<{ provider: 'openai' | 'openai-codex'; model_id: string; credential_reference: string }>(
        'SELECT provider,model_id,credential_reference FROM agent_compute_profiles WHERE outline_id=$1', [principal.outlineId],
      )
    if (!configurationResult.rows[0] || !automationResult.rows[0] || !computeResult.rows[0]) return
    const configuration = portableAgentConfigurationSchema.parse(configurationResult.rows[0].configuration)
    const policies = automationPolicySetSchema.parse(automationResult.rows[0].policies)
    const compute = computeResult.rows[0]
    const matches = await resolveAutomationMatches(
      policies,
      captureFacts(capture.text, capture.source),
      { text: capture.text, source: capture.source ?? {} },
      async (agentId) => {
        const agent = configuration.agents.find((candidate) => candidate.id === agentId)
        if (!agent || !this.dispatcherForAgent) return undefined
        const credential = await client.query(
          `SELECT id FROM agent_provider_credentials WHERE id=$1 AND owner_id=$2 AND outline_id=$3 AND status='connected'`,
          [compute.credential_reference, principal.ownerId, principal.outlineId],
        )
        if (!credential.rowCount) return undefined
        return this.dispatcherForAgent({ ownerId: principal.ownerId, outlineId: principal.outlineId, agent: {
          ...agent, modelId: compute.model_id, credentialRef: compute.credential_reference,
        } })
      },
      AbortSignal.timeout(15_000),
    )
    for (const match of matches) {
      const skill = configuration.skills.find((candidate) => candidate.id === match.skillId)
      const agent = skill ? configuration.agents.find((candidate) => candidate.id === skill.agentId) : undefined
      const credentialRef = compute.credential_reference
      if (!skill || !agent) continue
      const resolvedAgent = { ...agent, modelId: compute.model_id, credentialRef }
      const credential = await client.query(
        `SELECT id FROM agent_provider_credentials WHERE id=$1 AND owner_id=$2 AND outline_id=$3 AND status='connected'`,
        [credentialRef, principal.ownerId, principal.outlineId],
      )
      if (!credential.rowCount) continue
      let effectiveToolIds: string[]
      try {
        effectiveToolIds = resolveEffectiveToolIds({
          agentToolIds: resolvedAgent.toolIds, requiredToolIds: skill.requiredToolIds,
          globallyEnabledToolIds: configuration.globallyEnabledToolIds,
          policyAllowedToolIds: configuration.globallyEnabledToolIds,
          executorSupportedToolIds: this.supportedAgentToolIds,
        })
      } catch { continue }
      const runId = `run_${randomUUID()}`
      const input: RunInput = {
        version: 1, runId, executionMode: 'server', outlineId: principal.outlineId,
        source: { nodeId: noteId, text: capture.text, ...(capture.source ? { properties: capture.source } : {}) },
        target: { parentId: noteId }, baseRevision, configurationRevision: configuration.revision,
        credentialRef, agent: resolvedAgent, skill, effectiveToolIds,
        prompt: 'Process this Inbox capture using the selected skill.', context: [capture.text],
        customTools: configuration.customTools,
      }
      await client.query(
        `INSERT INTO agent_runs
         (id,owner_id,outline_id,trigger_kind,trigger_identity,source_note_id,target_note_id,input_snapshot,
          definition_snapshot,configuration_revision,credential_reference,status,max_attempts)
         VALUES ($1,$2,$3,'inbox_automation',$4,$5,$5,$6,$7,$8,$9,'queued',$10)
         ON CONFLICT (outline_id,trigger_identity) DO NOTHING`,
        [runId, principal.ownerId, principal.outlineId,
          `capture:${noteId}:policy:${policies.revision}:skill:${skill.id}`, noteId, input,
          { agent: resolvedAgent, skill, effectiveToolIds, policyId: match.policyId }, configuration.revision,
          credentialRef, this.agentMaxAttempts],
      )
    }
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

  async acceptEvents(principal: BoundPrincipal, baseRevision: number, events: EventEnvelope[]) {
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
      if (revision !== currentRevision) {
        const latest = await this.canonicalProjection(client, principal.outlineId, true)
        await this.rebuildNoteIndex(client, principal.outlineId, latest.state, revision)
      }
      return acknowledgements
    })
  }

  async initiateAsset(
    principal: BoundPrincipal,
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

  async completeAsset(principal: BoundPrincipal, assetId: string, storageKey: string): Promise<AssetRecord> {
    const result = await this.pool.query<AssetRow>(
      `UPDATE assets SET storage_key = $3, completed_at = COALESCE(completed_at, now())
       WHERE asset_id = $1 AND owner_id = $2
       RETURNING asset_id, owner_id, media_type, byte_size, storage_key, completed_at`,
      [assetId, principal.ownerId, storageKey],
    )
    if (!result.rows[0]) throw hiddenResourceError()
    return assetFromRow(result.rows[0])
  }

  async asset(principal: BoundPrincipal, assetId: string): Promise<AssetRecord> {
    const result = await this.pool.query<AssetRow>(
      `SELECT asset_id, owner_id, media_type, byte_size, storage_key, completed_at
       FROM assets WHERE asset_id = $1 AND owner_id = $2 AND completed_at IS NOT NULL`,
      [assetId, principal.ownerId],
    )
    if (!result.rows[0]) throw hiddenResourceError()
    return assetFromRow(result.rows[0])
  }

  async runAdmissionContext(principal: BoundPrincipal, sourceNodeId: string, targetParentId: string) {
    const projection = await this.canonicalProjection(this.pool, principal.outlineId)
    const canonical = queryCanonicalOutline(projection.state)
    const source = requireLiveCanonicalNode(canonical, sourceNodeId, 'source')
    const target = requireLiveCanonicalNode(canonical, targetParentId, 'target')
    return {
      sourceText: source.text,
      context: canonical.ancestors(target.id).map((note) => note.text),
      baseRevision: projection.revision,
    }
  }

  async searchOutline(outlineId: string, query: string, limit = 20) {
    const status = await this.noteIndexStatus(outlineId)
    if (!status.ready) {
      const projection = await this.canonicalProjection(this.pool, outlineId)
      const needle = query.trim().toLocaleLowerCase()
      return queryCanonicalOutline(projection.state).nodes()
        .filter((node) => node.text.toLocaleLowerCase().includes(needle))
        .slice(0, Math.max(1, Math.min(limit, 50)))
        .map((node) => ({ nodeId: node.id, text: node.text.slice(0, 2_000) }))
    }
    const result = await this.pool.query<{ id: string; text_content: string }>(
      `SELECT id,text_content FROM note_projections WHERE outline_id=$1 AND deleted=false
       AND text_content ILIKE $2 ORDER BY created_at DESC LIMIT $3`,
      [outlineId, `%${query.trim().replace(/[\\%_]/g, '\\$&')}%`, Math.max(1, Math.min(limit, 50))],
    )
    return result.rows.map((row) => ({ nodeId: row.id, text: row.text_content.slice(0, 2_000) }))
  }

  async noteIndexStatus(outlineId: string) {
    const result = await this.pool.query<{ source_revision: string; schema_version: number; current_revision: string; rebuild_status: string }>(
      `SELECT s.source_revision,s.schema_version,s.rebuild_status,o.current_revision
       FROM outlines o LEFT JOIN note_projection_status s ON s.outline_id=o.id WHERE o.id=$1`,
      [outlineId],
    )
    const row = result.rows[0]
    if (!row) throw hiddenResourceError()
    const sourceRevision = Number(row.source_revision ?? -1)
    return {
      ready: row.rebuild_status === 'ready' && row.schema_version === NOTE_PROJECTOR_SCHEMA_VERSION && sourceRevision === Number(row.current_revision),
      sourceRevision,
      schemaVersion: row.schema_version ?? 0,
    }
  }

  async reconcileNoteProjections(): Promise<number> {
    const outlines = await this.pool.query<{
      outline_id: string; revision: string; current_revision: string; state: OutlineState
      source_revision: string | null; schema_version: number | null; rebuild_status: string | null; note_count: string
    }>(
      `SELECT p.outline_id,p.revision,p.state,o.current_revision,
          s.source_revision,s.schema_version,s.rebuild_status,
          (SELECT count(*) FROM note_projections n WHERE n.outline_id=p.outline_id AND n.deleted=false) AS note_count
       FROM outline_projections p
       JOIN outlines o ON o.id=p.outline_id
       LEFT JOIN note_projection_status s ON s.outline_id=p.outline_id`,
    )
    const stale = outlines.rows.filter((outline) => {
      const expectedCount = noteProjectionsFromState(outline.state).length
      return outline.rebuild_status !== 'ready'
        || outline.schema_version !== NOTE_PROJECTOR_SCHEMA_VERSION
        || Number(outline.source_revision ?? -1) !== Number(outline.revision)
        || Number(outline.revision) !== Number(outline.current_revision)
        || Number(outline.note_count) !== expectedCount
    })
    for (const outline of stale) {
      await this.transaction(async (client) => {
        const current = await this.canonicalProjection(client, outline.outline_id, true)
        await this.rebuildNoteIndex(client, outline.outline_id, current.state, current.revision)
      })
    }
    return stale.length
  }

  async commitAgentResult(runId: string, workerId: string, rawResult: StructuredResult) {
    const result = parseStructuredResult(rawResult)
    await this.agentStore.persistOutput(runId, workerId, `result:${runId}`, result)
    const committed = await this.transaction(async (client) => {
      const selected = await client.query<{
        id: string; owner_id: string; outline_id: string; input_snapshot: unknown; status: string; lease_owner: string | null
        cancel_requested_at: Date | null; attempt_count: number
      }>('SELECT * FROM agent_runs WHERE id = $1 FOR UPDATE', [runId])
      const run = selected.rows[0]
      if (!run) throw hiddenResourceError()
      const existing = await client.query<{ first_revision: string; last_revision: string; root_note_ids: string[] }>(
        'SELECT first_revision, last_revision, root_note_ids FROM agent_run_results WHERE run_id = $1', [runId],
      )
      if (existing.rows[0]) return {
        placement: 'placed' as const,
        firstRevision: Number(existing.rows[0].first_revision), lastRevision: Number(existing.rows[0].last_revision), rootNoteIds: existing.rows[0].root_note_ids,
      }
      if (run.status !== 'running' || run.lease_owner !== workerId) throw new RepositoryError('conflict', 'Run lease was lost.')
      if (run.cancel_requested_at) throw new RepositoryError('conflict', 'Run cancellation was requested.')
      const input = runInputSchema.parse(run.input_snapshot)
      const projection = await this.canonicalProjection(client, run.outline_id, true)
      const target = queryCanonicalOutline(projection.state).resolve(input.target.parentId)
      if (target.state !== 'live') {
        return { placement: 'unplaced' as const, reason: `target_${target.state}` }
      }
      const imageIds = collectImageIds(result)
      if (imageIds.length) {
        const assets = await client.query(
          'SELECT asset_id FROM assets WHERE owner_id=$1 AND completed_at IS NOT NULL AND asset_id = ANY($2::text[])',
          [run.owner_id, imageIds],
        )
        if (assets.rowCount !== imageIds.length) throw new RepositoryError('conflict', 'Structured result references an unavailable asset.')
      }
      const outline = await client.query<{ current_revision: string; document_version: number; schema_epoch: number }>(
        'SELECT current_revision, document_version, schema_epoch FROM outlines WHERE id=$1 FOR UPDATE', [run.outline_id],
      )
      const revision = Number(outline.rows[0]!.current_revision) + 1
      const nodes = assignResultNodeIds(result.nodes, runId)
      const rootNoteIds = nodes.filter((node) => node.type === 'text').map((node) => node.nodeId)
      if (!rootNoteIds.length) throw new RepositoryError('conflict', 'Structured result must contain a text root.')
      const provenance = {
        runId, skillId: input.skill.id, ...(input.source.nodeId ? { sourceNodeId: input.source.nodeId } : {}),
        sourceUrls: result.sources.map((source) => source.url).slice(0, 20),
      }
      const event = parseEventEnvelope({
        id: `event_${randomUUID()}`, outlineId: run.outline_id, actorId: run.owner_id,
        deviceId: `agent_${this.instanceId}`, type: 'agent.result_committed', eventVersion: 1,
        documentVersion: outline.rows[0]!.document_version, schemaEpoch: outline.rows[0]!.schema_epoch,
        baseRevision: revision - 1, revision, origin: 'agent', agentProvenance: provenance,
        changeGroupId: `run_${runId}`.slice(0, 128), occurredAt: new Date().toISOString(),
        payload: { runId, targetNodeId: input.target.parentId, nodes, sources: result.sources },
      })
      await this.insertEvent(client, event)
      await this.applyProjection(client, run.outline_id, revision, event)
      const settled = { firstRevision: revision, lastRevision: revision, rootNoteIds }
      await client.query('UPDATE outlines SET current_revision=$2 WHERE id=$1', [run.outline_id, revision])
      const latest = await this.canonicalProjection(client, run.outline_id, true)
      await this.rebuildNoteIndex(client, run.outline_id, latest.state, revision)
      await client.query(
        `INSERT INTO agent_run_results(run_id,result_identity,first_revision,last_revision,root_note_ids)
         VALUES ($1,$2,$3,$4,$5)`, [runId, `result:${runId}`, revision, revision, rootNoteIds],
      )
      await client.query(
        `UPDATE agent_run_attempts SET status='completed',finished_at=now() WHERE run_id=$1 AND attempt_number=$2`,
        [runId, run.attempt_count],
      )
      await client.query(
        `UPDATE agent_runs SET status='completed',error_code=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1`,
        [runId],
      )
      return { placement: 'placed' as const, ...settled }
    })
    if (committed.placement === 'unplaced') {
      await this.agentStore.completeUnplaced(runId, workerId, committed.reason)
    }
    return committed
  }

  async placeAgentResult(principal: BoundPrincipal, runId: string, targetNodeId: string) {
    return this.transaction(async (client) => {
      const selected = await client.query<{
        owner_id: string; outline_id: string; input_snapshot: unknown; status: string
      }>('SELECT owner_id,outline_id,input_snapshot,status FROM agent_runs WHERE id=$1 AND outline_id=$2 FOR UPDATE', [runId, principal.outlineId])
      const run = selected.rows[0]
      if (!run) throw hiddenResourceError()
      const existing = await client.query<{ first_revision: string; last_revision: string; root_note_ids: string[] }>(
        'SELECT first_revision,last_revision,root_note_ids FROM agent_run_results WHERE run_id=$1', [runId],
      )
      if (existing.rows[0]) return {
        firstRevision: Number(existing.rows[0].first_revision),
        lastRevision: Number(existing.rows[0].last_revision),
        rootNoteIds: existing.rows[0].root_note_ids,
      }
      if (run.status !== 'completed_unplaced') throw new RepositoryError('conflict', 'Run output is not awaiting placement.')
      const output = await client.query<{ result_identity: string; structured_output: StructuredResult }>(
        'SELECT result_identity,structured_output FROM agent_run_outputs WHERE run_id=$1 FOR UPDATE', [runId],
      )
      if (!output.rows[0]) throw new RepositoryError('conflict', 'Persisted run output is unavailable.')
      const result = parseStructuredResult(output.rows[0].structured_output)
      const projection = await this.canonicalProjection(client, run.outline_id, true)
      requireLiveCanonicalNode(queryCanonicalOutline(projection.state), targetNodeId, 'target')
      const imageIds = collectImageIds(result)
      if (imageIds.length) {
        const assets = await client.query(
          'SELECT asset_id FROM assets WHERE owner_id=$1 AND completed_at IS NOT NULL AND asset_id = ANY($2::text[])',
          [run.owner_id, imageIds],
        )
        if (assets.rowCount !== imageIds.length) throw new RepositoryError('conflict', 'Structured result references an unavailable asset.')
      }
      const outline = await client.query<{ current_revision: string; document_version: number; schema_epoch: number }>(
        'SELECT current_revision,document_version,schema_epoch FROM outlines WHERE id=$1 FOR UPDATE', [run.outline_id],
      )
      const revision = Number(outline.rows[0]!.current_revision) + 1
      const input = runInputSchema.parse(run.input_snapshot)
      const nodes = assignResultNodeIds(result.nodes, runId)
      const rootNoteIds = nodes.filter((node) => node.type === 'text').map((node) => node.nodeId)
      if (!rootNoteIds.length) throw new RepositoryError('conflict', 'Structured result must contain a text root.')
      const event = parseEventEnvelope({
        id: `event_${randomUUID()}`, outlineId: run.outline_id, actorId: run.owner_id,
        deviceId: `agent_${this.instanceId}`, type: 'agent.result_committed', eventVersion: 1,
        documentVersion: outline.rows[0]!.document_version, schemaEpoch: outline.rows[0]!.schema_epoch,
        baseRevision: revision - 1, revision, origin: 'agent',
        agentProvenance: {
          runId, skillId: input.skill.id, ...(input.source.nodeId ? { sourceNodeId: input.source.nodeId } : {}),
          sourceUrls: result.sources.map((source) => source.url).slice(0, 20),
        },
        changeGroupId: `run_${runId}`.slice(0, 128), occurredAt: new Date().toISOString(),
        payload: { runId, targetNodeId, nodes, sources: result.sources },
      })
      await this.insertEvent(client, event)
      await this.applyProjection(client, run.outline_id, revision, event)
      await client.query('UPDATE outlines SET current_revision=$2 WHERE id=$1', [run.outline_id, revision])
      const latest = await this.canonicalProjection(client, run.outline_id, true)
      await this.rebuildNoteIndex(client, run.outline_id, latest.state, revision)
      await client.query(
        `INSERT INTO agent_run_results(run_id,result_identity,first_revision,last_revision,root_note_ids)
         VALUES ($1,$2,$3,$3,$4)`, [runId, output.rows[0].result_identity, revision, rootNoteIds],
      )
      await client.query(
        `UPDATE agent_run_outputs SET placed_at=now(),target_note_id=$2 WHERE run_id=$1`, [runId, targetNodeId],
      )
      await client.query(
        `UPDATE agent_runs SET status='completed',placement_error=NULL,target_note_id=$2,updated_at=now() WHERE id=$1`,
        [runId, targetNodeId],
      )
      return { firstRevision: revision, lastRevision: revision, rootNoteIds }
    })
  }

  private async requireCompletedAssets(client: PoolClient, principal: BoundPrincipal, event: EventEnvelope): Promise<void> {
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
        schema_epoch, actor_id, device_id, origin, change_group_id, payload, occurred_at, agent_provenance)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [event.id, event.outlineId, event.revision, event.baseRevision, event.type, event.eventVersion,
        event.documentVersion, event.schemaEpoch, event.actorId, event.deviceId, event.origin,
        event.changeGroupId ?? null, event.payload, event.occurredAt, event.agentProvenance ?? null],
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

  private async rebuildNoteIndex(client: PoolClient, outlineId: string, state: OutlineState, revision: number): Promise<void> {
    const notes = noteProjectionsFromState(state).map((note) => ({ id: note.id, parent_id: note.parentId, text_content: note.text }))
    await client.query(
      `INSERT INTO note_projection_status(outline_id,source_revision,schema_version,rebuild_status,updated_at)
       VALUES ($1,$2,$3,'rebuilding',now())
       ON CONFLICT (outline_id) DO UPDATE SET rebuild_status='rebuilding',updated_at=now()`,
      [outlineId, revision, NOTE_PROJECTOR_SCHEMA_VERSION],
    )
    await client.query('DELETE FROM note_projections WHERE outline_id=$1', [outlineId])
    await client.query(
      `INSERT INTO note_projections(outline_id, id, parent_id, text_content, deleted, created_at)
       SELECT $1, note.id, note.parent_id, note.text_content, false, now()
       FROM jsonb_to_recordset($2::jsonb) AS note(id text, parent_id text, text_content text)
       ON CONFLICT (outline_id, id) DO UPDATE SET
         parent_id = EXCLUDED.parent_id,
         text_content = EXCLUDED.text_content,
         deleted = false`,
      [outlineId, JSON.stringify(notes)],
    )
    await client.query(
      `UPDATE note_projection_status SET source_revision=$2,schema_version=$3,rebuild_status='ready',updated_at=now()
       WHERE outline_id=$1`,
      [outlineId, revision, NOTE_PROJECTOR_SCHEMA_VERSION],
    )
  }

  private async canonicalProjection(
    connection: Pick<Pool, 'query'> | Pick<PoolClient, 'query'>,
    outlineId: string,
    lock = false,
  ): Promise<{ state: OutlineState; revision: number }> {
    const result = await connection.query<{ state: OutlineState; revision: string }>(
      `SELECT p.state, p.revision FROM outline_projections p
       JOIN outlines o ON o.id=p.outline_id AND o.current_revision=p.revision
       WHERE p.outline_id=$1${lock ? ' FOR UPDATE OF p' : ''}`,
      [outlineId],
    )
    if (!result.rows[0]) {
      throw new RepositoryError('outline_not_synchronized', 'The canonical outline projection is not synchronized.', 'synchronize_outline')
    }
    return { state: result.rows[0].state, revision: Number(result.rows[0].revision) }
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
  agent_provenance: EventEnvelope['agentProvenance'] | null
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
    agentProvenance: row.agent_provenance ?? undefined,
    payload: row.payload, occurredAt: row.occurred_at.toISOString(),
  })
}

function collectImageIds(result: StructuredResult): string[] {
  const found = new Set<string>()
  const visit = (nodes: StructuredResult['nodes']): void => nodes.forEach((node) => {
    if (node.type === 'image') found.add(node.assetId)
    else if (node.children) visit(node.children)
  })
  visit(result.nodes)
  return [...found]
}

function assignResultNodeIds(nodes: StructuredResult['nodes'], runId: string, prefix = ''): Array<
  | { type: 'text'; nodeId: string; text: string; children?: ReturnType<typeof assignResultNodeIds> }
  | { type: 'image'; assetId: string; alt: string }
> {
  return nodes.map((node, index) => node.type === 'image' ? node : ({
    type: 'text' as const, nodeId: `note_${runId}_${prefix}${index}`.slice(0, 128), text: node.text,
    ...(node.children?.length ? { children: assignResultNodeIds(node.children, runId, `${prefix}${index}_`) } : {}),
  }))
}

function hiddenResourceError(): RepositoryError {
  return new RepositoryError('authorization_denied', 'The requested resource is unavailable.')
}

function canonicalNodeError(kind: 'source' | 'target', state: 'missing' | 'trashed'): RepositoryError {
  const code = `${kind}_${state}` as 'source_missing' | 'source_trashed' | 'target_missing' | 'target_trashed'
  return new RepositoryError(code, `The ${kind} node is ${state}.`, state === 'trashed' ? 'restore_or_choose_another' : 'choose_another')
}

function requireLiveCanonicalNode(
  query: ReturnType<typeof queryCanonicalOutline>,
  nodeId: string,
  kind: 'source' | 'target',
) {
  const resolution = query.resolve(nodeId)
  if (resolution.state !== 'live') throw canonicalNodeError(kind, resolution.state)
  return resolution.node
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}
