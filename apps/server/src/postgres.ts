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
import { createOutlineSchema, findSystemNode, repairSystemNodes } from '@forage/document'
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
} from './repository.js'
import { PostgresAgentStore } from './postgresAgentStore.js'
import { agentConfigurationSchema, parseStructuredResult, resolveEffectiveToolIds, runInputSchema, type RunInput, type StructuredResult } from '@forage/agent-runtime'
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
      const outlineId = `outline_${randomUUID()}`
      const inboxId = `note_${randomUUID()}`
      const dailyNotesId = `note_${randomUUID()}`
      const editableId = `note_${randomUUID()}`
      const now = new Date().toISOString()
      const systemIds = [inboxId, dailyNotesId]
      const repaired = repairSystemNodes({
        type: 'doc',
        content: [{
          type: 'bulletList',
          content: [{
            type: 'listItem',
            attrs: {
              nodeId: editableId, nodeType: 'user', collapsed: false, bulletKind: 'bullet', completed: false,
              systemRole: null, dailyDate: null,
            },
            content: [{ type: 'paragraph' }],
          }],
        }],
      }, () => systemIds.shift()!)
      const state = createInitialOutlineState(repaired.doc)
      const checkpointId = `checkpoint_${randomUUID()}`
      const integrityHash = await sha256Hex(canonicalJson(state))

      await client.query('INSERT INTO owners(id, email) VALUES ($1, $2)', [ownerId, email])
      await client.query(
        `INSERT INTO outlines(id, owner_id, name, api_inbox_id) VALUES ($1, $2, 'Notes', $3)`,
        [outlineId, ownerId, inboxId],
      )
      await client.query(
        `INSERT INTO note_projections(outline_id, id, parent_id, text_content, created_at)
         VALUES ($1, $2, NULL, 'Inbox', $5),
                ($1, $3, NULL, 'Daily Notes', $5),
                ($1, $4, NULL, '', $5)`,
        [outlineId, inboxId, dailyNotesId, editableId, now],
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
      const deviceToken = await this.issueToken(client, ownerId, outlineId, 'device', 'Initial desktop', ['sync', 'agents:read', 'agents:execute', 'agents:manage'])
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

      const projection = await client.query<{ state: OutlineState }>(
        'SELECT state FROM outline_projections WHERE outline_id = $1', [principal.outlineId],
      )
      const inbox = projection.rows[0]
        ? findSystemNode(createOutlineSchema().nodeFromJSON(projection.rows[0].state.doc), 'inbox')
        : null
      if (!inbox) throw new RepositoryError('conflict', 'The canonical Inbox is unavailable.')
      const parentId = input.parentId ?? inbox.id
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
      if (parentId === inbox.id) await this.admitAutomaticRuns(client, principal, noteId, input, revision)
      return { response, replayed: false }
    })
  }

  private async admitAutomaticRuns(
    client: PoolClient, principal: Principal, noteId: string, capture: NotesCreateRequest, baseRevision: number,
  ): Promise<void> {
    const [configurationResult, automationResult] = await Promise.all([
      client.query<{ configuration: unknown }>(
        'SELECT configuration FROM agent_configuration_revisions WHERE outline_id=$1 ORDER BY revision DESC LIMIT 1', [principal.outlineId],
      ),
      client.query<{ policies: unknown }>(
        'SELECT policies FROM agent_automation_revisions WHERE outline_id=$1 ORDER BY revision DESC LIMIT 1', [principal.outlineId],
      ),
    ])
    if (!configurationResult.rows[0] || !automationResult.rows[0]) return
    const configuration = agentConfigurationSchema.parse(configurationResult.rows[0].configuration)
    const policies = automationPolicySetSchema.parse(automationResult.rows[0].policies)
    const matches = await resolveAutomationMatches(
      policies,
      captureFacts(capture.text, capture.source),
      { text: capture.text, source: capture.source ?? {} },
      async (agentId) => {
        const agent = configuration.agents.find((candidate) => candidate.id === agentId)
        if (!agent?.credentialRef || !this.dispatcherForAgent) return undefined
        const credential = await client.query(
          `SELECT id FROM agent_provider_credentials WHERE id=$1 AND owner_id=$2 AND outline_id=$3 AND status='connected'`,
          [agent.credentialRef, principal.ownerId, principal.outlineId],
        )
        if (!credential.rowCount) return undefined
        return this.dispatcherForAgent({ ownerId: principal.ownerId, outlineId: principal.outlineId, agent })
      },
      AbortSignal.timeout(15_000),
    )
    for (const match of matches) {
      const skill = configuration.skills.find((candidate) => candidate.id === match.skillId)
      const agent = skill ? configuration.agents.find((candidate) => candidate.id === skill.agentId) : undefined
      const credentialRef = agent?.credentialRef
      if (!skill || !agent || !credentialRef) continue
      const credential = await client.query(
        `SELECT id FROM agent_provider_credentials WHERE id=$1 AND owner_id=$2 AND outline_id=$3 AND status='connected'`,
        [credentialRef, principal.ownerId, principal.outlineId],
      )
      if (!credential.rowCount) continue
      let effectiveToolIds: string[]
      try {
        effectiveToolIds = resolveEffectiveToolIds({
          agentToolIds: agent.toolIds, requiredToolIds: skill.requiredToolIds,
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
        credentialRef, agent, skill, effectiveToolIds,
        prompt: 'Process this Inbox capture using the selected skill.', context: [capture.text],
        customTools: configuration.customTools,
      }
      await client.query(
        `INSERT INTO agent_runs
         (id,owner_id,outline_id,trigger_kind,trigger_identity,source_note_id,target_note_id,input_snapshot,
          definition_snapshot,configuration_revision,credential_reference,status,max_attempts)
         VALUES ($1,$2,$3,'inbox_automation',$4,$5,$5,$6,$7,$8,$9,'queued',$10)
         ON CONFLICT (outline_id,trigger_identity,configuration_revision) DO NOTHING`,
        [runId, principal.ownerId, principal.outlineId,
          `capture:${noteId}:policy:${policies.revision}:skill:${skill.id}`, noteId, input,
          { agent, skill, effectiveToolIds, policyId: match.policyId }, configuration.revision,
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

  async runAdmissionContext(principal: Principal, sourceNodeId: string, targetParentId: string) {
    const notes = await this.pool.query<{ id: string; parent_id: string | null; text_content: string }>(
      `WITH RECURSIVE ancestors AS (
         SELECT id, parent_id, text_content, 1 AS depth FROM note_projections
          WHERE outline_id = $1 AND id = $2 AND deleted = false
         UNION ALL
         SELECT parent.id, parent.parent_id, parent.text_content, child.depth + 1
          FROM note_projections parent JOIN ancestors child ON child.parent_id = parent.id
          WHERE parent.outline_id = $1 AND parent.deleted = false AND child.depth < 20
       ) SELECT id, parent_id, text_content FROM ancestors`,
      [principal.outlineId, targetParentId],
    )
    const source = await this.pool.query<{ text_content: string }>(
      'SELECT text_content FROM note_projections WHERE outline_id = $1 AND id = $2 AND deleted = false',
      [principal.outlineId, sourceNodeId],
    )
    if (!source.rows[0] || !notes.rows.some((note) => note.id === targetParentId)) throw hiddenResourceError()
    return {
      sourceText: source.rows[0].text_content,
      context: [...notes.rows].reverse().map((note) => note.text_content),
      baseRevision: await this.currentRevision(principal.outlineId),
    }
  }

  async searchOutline(outlineId: string, query: string, limit = 20) {
    const result = await this.pool.query<{ id: string; text_content: string }>(
      `SELECT id,text_content FROM note_projections WHERE outline_id=$1 AND deleted=false
       AND text_content ILIKE $2 ORDER BY created_at DESC LIMIT $3`,
      [outlineId, `%${query.trim().replace(/[\\%_]/g, '\\$&')}%`, Math.max(1, Math.min(limit, 50))],
    )
    return result.rows.map((row) => ({ nodeId: row.id, text: row.text_content.slice(0, 2_000) }))
  }

  async commitAgentResult(runId: string, workerId: string, rawResult: StructuredResult) {
    const result = parseStructuredResult(rawResult)
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
        firstRevision: Number(existing.rows[0].first_revision), lastRevision: Number(existing.rows[0].last_revision), rootNoteIds: existing.rows[0].root_note_ids,
      }
      if (run.status !== 'running' || run.lease_owner !== workerId) throw new RepositoryError('conflict', 'Run lease was lost.')
      if (run.cancel_requested_at) throw new RepositoryError('conflict', 'Run cancellation was requested.')
      const input = runInputSchema.parse(run.input_snapshot)
      const target = await client.query(
        'SELECT id FROM note_projections WHERE outline_id = $1 AND id = $2 AND deleted = false FOR UPDATE',
        [run.outline_id, input.target.parentId],
      )
      if (!target.rowCount) {
        await client.query(
          `UPDATE agent_runs SET status='cancelled', error_code='target_unavailable', lease_owner=NULL,
           lease_expires_at=NULL, updated_at=now() WHERE id=$1`, [runId],
        )
        await client.query(
          `UPDATE agent_run_attempts SET status='cancelled', error_code='target_unavailable', finished_at=now()
           WHERE run_id=$1 AND attempt_number=$2`, [runId, run.attempt_count],
        )
        return null
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
      let revision = Number(outline.rows[0]!.current_revision)
      const firstRevision = revision + 1
      const rootNoteIds: string[] = []
      const changeGroupId = `run_${runId}`.slice(0, 128)
      const provenance = {
        runId, skillId: input.skill.id, ...(input.source.nodeId ? { sourceNodeId: input.source.nodeId } : {}),
        sourceUrls: result.sources.map((source) => source.url).slice(0, 20),
      }
      const addNodes = async (nodes: StructuredResult['nodes'], parentId: string): Promise<void> => {
        for (const node of nodes) {
          revision += 1
          if (node.type === 'image') {
            const event = parseEventEnvelope({
              id: `event_${randomUUID()}`, outlineId: run.outline_id, actorId: run.owner_id,
              deviceId: `agent_${this.instanceId}`, type: 'asset.reference_added', eventVersion: 1,
              documentVersion: outline.rows[0]!.document_version, schemaEpoch: outline.rows[0]!.schema_epoch,
              baseRevision: revision - 1, revision, origin: 'agent', agentProvenance: provenance,
              changeGroupId, occurredAt: new Date().toISOString(), payload: { assetId: node.assetId, alt: node.alt },
            })
            await this.insertEvent(client, event); await this.applyProjection(client, run.outline_id, revision, event)
            continue
          }
          const noteId = `note_${randomUUID()}`
          if (parentId === input.target.parentId) rootNoteIds.push(noteId)
          const event = parseEventEnvelope({
            id: `event_${randomUUID()}`, outlineId: run.outline_id, actorId: run.owner_id,
            deviceId: `agent_${this.instanceId}`, type: 'note.created', eventVersion: 1,
            documentVersion: outline.rows[0]!.document_version, schemaEpoch: outline.rows[0]!.schema_epoch,
            baseRevision: revision - 1, revision, origin: 'agent', agentProvenance: provenance,
            changeGroupId, occurredAt: new Date().toISOString(), payload: { noteId, parentId, text: node.text },
          })
          await this.insertEvent(client, event)
          await client.query(
            `INSERT INTO note_projections(outline_id,id,parent_id,text_content,created_at) VALUES ($1,$2,$3,$4,$5)`,
            [run.outline_id, noteId, parentId, node.text, event.occurredAt],
          )
          await this.applyProjection(client, run.outline_id, revision, event)
          if (node.children?.length) await addNodes(node.children, noteId)
        }
      }
      await addNodes(result.nodes, input.target.parentId)
      if (!rootNoteIds.length) throw new RepositoryError('conflict', 'Structured result must contain a text root.')
      const settled = { firstRevision, lastRevision: revision, rootNoteIds }
      await client.query('UPDATE outlines SET current_revision=$2 WHERE id=$1', [run.outline_id, revision])
      await client.query(
        `INSERT INTO agent_run_results(run_id,result_identity,first_revision,last_revision,root_note_ids)
         VALUES ($1,$2,$3,$4,$5)`, [runId, `result:${runId}`, firstRevision, revision, rootNoteIds],
      )
      await client.query(
        `UPDATE agent_run_attempts SET status='completed',finished_at=now() WHERE run_id=$1 AND attempt_number=$2`,
        [runId, run.attempt_count],
      )
      await client.query(
        `UPDATE agent_runs SET status='completed',error_code=NULL,lease_owner=NULL,lease_expires_at=NULL,updated_at=now() WHERE id=$1`,
        [runId],
      )
      return settled
    })
    if (!committed) throw new RepositoryError('conflict', 'The target is unavailable.')
    return committed
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

function hiddenResourceError(): RepositoryError {
  return new RepositoryError('authorization_denied', 'The requested resource is unavailable.')
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}
