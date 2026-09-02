import type { Pool, PoolClient, QueryResultRow } from 'pg'
import {
  activityEventSchema,
  agentConfigurationSchema,
  runInputSchema,
  runStatusSchema,
  type ActivityEvent,
  type AgentConfiguration,
  type RunInput,
  type RunStatus,
} from '@forage/agent-runtime'
import { automationPolicySetSchema, type AutomationPolicySet } from '@forage/protocol'
import {
  AgentStoreError,
  type AdmitRunInput,
  type AgentRunRecord,
  type AgentRunResult,
  type AgentStore,
  type PublishedAutomation,
  type PublishedConfiguration,
} from './agentStore.js'

export class PostgresAgentStore implements AgentStore {
  constructor(private readonly pool: Pool) {}

  async currentConfiguration(outlineId: string): Promise<PublishedConfiguration | null> {
    const result = await this.pool.query<{ configuration: unknown; published_at: Date }>(
      'SELECT configuration, published_at FROM agent_configuration_revisions WHERE outline_id = $1 ORDER BY revision DESC LIMIT 1', [outlineId],
    )
    return result.rows[0] ? { configuration: agentConfigurationSchema.parse(result.rows[0].configuration), publishedAt: result.rows[0].published_at.toISOString() } : null
  }

  async publishConfiguration(outlineId: string, baseRevision: number, configuration: AgentConfiguration, publishedBy?: string): Promise<PublishedConfiguration> {
    if (!publishedBy) throw new AgentStoreError('invalid_state', 'Publishing credential is required.')
    const parsed = agentConfigurationSchema.parse(configuration)
    return this.transaction(async (client) => {
      await lockOutline(client, outlineId)
      const current = await currentRevision(client, 'agent_configuration_revisions', outlineId)
      if (current !== baseRevision || parsed.revision !== baseRevision + 1) throw new AgentStoreError('conflict', 'Agent configuration revision conflict.')
      const result = await client.query<{ published_at: Date }>(
        `INSERT INTO agent_configuration_revisions(outline_id, revision, configuration, published_by)
         VALUES ($1,$2,$3,$4) RETURNING published_at`, [outlineId, parsed.revision, parsed, publishedBy],
      )
      return { configuration: parsed, publishedAt: result.rows[0]!.published_at.toISOString() }
    })
  }

  async currentAutomation(outlineId: string): Promise<PublishedAutomation | null> {
    const result = await this.pool.query<{ policies: unknown; published_at: Date }>(
      'SELECT policies, published_at FROM agent_automation_revisions WHERE outline_id = $1 ORDER BY revision DESC LIMIT 1', [outlineId],
    )
    return result.rows[0] ? { policies: automationPolicySetSchema.parse(result.rows[0].policies), publishedAt: result.rows[0].published_at.toISOString() } : null
  }

  async publishAutomation(outlineId: string, baseRevision: number, policies: AutomationPolicySet, publishedBy?: string): Promise<PublishedAutomation> {
    if (!publishedBy) throw new AgentStoreError('invalid_state', 'Publishing credential is required.')
    const parsed = automationPolicySetSchema.parse(policies)
    return this.transaction(async (client) => {
      await lockOutline(client, outlineId)
      const current = await currentRevision(client, 'agent_automation_revisions', outlineId)
      if (current !== baseRevision || parsed.revision !== baseRevision + 1) throw new AgentStoreError('conflict', 'Automation policy revision conflict.')
      const result = await client.query<{ published_at: Date }>(
        `INSERT INTO agent_automation_revisions(outline_id, revision, policies, published_by)
         VALUES ($1,$2,$3,$4) RETURNING published_at`, [outlineId, parsed.revision, parsed, publishedBy],
      )
      return { policies: parsed, publishedAt: result.rows[0]!.published_at.toISOString() }
    })
  }

  async admitRun(admission: AdmitRunInput): Promise<AgentRunRecord> {
    const input = runInputSchema.parse(admission.input)
    if (!admission.ownerId) throw new AgentStoreError('invalid_state', 'Run owner is required.')
    const result = await this.pool.query<AgentRunRow>(
      `INSERT INTO agent_runs
       (id, owner_id, outline_id, trigger_kind, trigger_identity, source_note_id, target_note_id,
        input_snapshot, definition_snapshot, configuration_revision, credential_reference, status,
        max_attempts, retry_of_run_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'queued',$12,$13)
       ON CONFLICT (outline_id, trigger_identity, configuration_revision)
       DO UPDATE SET id = agent_runs.id
       RETURNING *`,
      [input.runId, admission.ownerId, input.outlineId, admission.trigger, admission.triggerIdentity,
        input.source.nodeId ?? null, input.target.parentId, input,
        { agent: input.agent, skill: input.skill, effectiveToolIds: input.effectiveToolIds, policyId: admission.policyId ?? null },
        input.configurationRevision, input.credentialRef, Math.max(1, Math.min(admission.maxAttempts, 20)), admission.retryOfRunId ?? null],
    )
    return runFromRow(result.rows[0]!)
  }

  async getRun(outlineId: string, runId: string): Promise<AgentRunRecord | null> {
    const result = await this.pool.query<AgentRunRow>(
      `SELECT r.*, result.first_revision, result.last_revision, result.root_note_ids
       FROM agent_runs r LEFT JOIN agent_run_results result ON result.run_id = r.id
       WHERE r.outline_id = $1 AND r.id = $2`, [outlineId, runId],
    )
    return result.rows[0] ? runFromRow(result.rows[0]) : null
  }

  async listRuns(outlineId: string, limit: number, before?: string, status?: RunStatus): Promise<AgentRunRecord[]> {
    const result = await this.pool.query<AgentRunRow>(
      `SELECT r.*, result.first_revision, result.last_revision, result.root_note_ids
       FROM agent_runs r LEFT JOIN agent_run_results result ON result.run_id = r.id
       WHERE r.outline_id = $1 AND ($2::timestamptz IS NULL OR r.created_at < $2)
         AND ($3::text IS NULL OR r.status = $3)
       ORDER BY r.created_at DESC, r.id DESC LIMIT $4`, [outlineId, before ?? null, status ?? null, Math.max(1, Math.min(limit, 100))],
    )
    return result.rows.map(runFromRow)
  }

  async activity(runId: string, afterSequence: number, limit: number): Promise<{ events: ActivityEvent[]; status: RunStatus }> {
    const [events, run] = await Promise.all([
      this.pool.query<{ event: unknown }>(
        'SELECT event FROM agent_run_events WHERE run_id = $1 AND sequence > $2 ORDER BY sequence ASC LIMIT $3',
        [runId, afterSequence, Math.max(1, Math.min(limit, 200))],
      ),
      this.pool.query<{ status: string }>('SELECT status FROM agent_runs WHERE id = $1', [runId]),
    ])
    if (!run.rows[0]) throw new AgentStoreError('not_found', 'Run is unavailable.')
    return { events: events.rows.map((row) => activityEventSchema.parse(row.event)), status: runStatusSchema.parse(run.rows[0].status) }
  }

  async appendActivity(runId: string, event: ActivityEvent): Promise<ActivityEvent> {
    return this.transaction(async (client) => {
      await client.query('SELECT id FROM agent_runs WHERE id = $1 FOR UPDATE', [runId])
      const sequenceResult = await client.query<{ sequence: string }>('SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM agent_run_events WHERE run_id = $1', [runId])
      const parsed = activityEventSchema.parse({ ...event, sequence: Number(sequenceResult.rows[0]!.sequence) })
      await client.query('INSERT INTO agent_run_events(run_id, sequence, event) VALUES ($1,$2,$3)', [runId, parsed.sequence, parsed])
      return parsed
    })
  }

  async claimNext(workerId: string, now: Date, leaseMs: number): Promise<AgentRunRecord | null> {
    return this.transaction(async (client) => {
      await client.query(
        `UPDATE agent_runs SET status = 'failed', error_code = 'attempts_exhausted', lease_owner = NULL,
          lease_expires_at = NULL, updated_at = $1
         WHERE status = 'running' AND lease_expires_at <= $1 AND attempt_count >= max_attempts`, [now],
      )
      const candidate = await client.query<AgentRunRow>(
        `SELECT * FROM agent_runs
         WHERE cancel_requested_at IS NULL AND attempt_count < max_attempts
           AND ((status IN ('queued','retry_wait') AND available_at <= $1)
             OR (status = 'running' AND lease_expires_at <= $1))
         ORDER BY available_at ASC, created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1`, [now],
      )
      const row = candidate.rows[0]
      if (!row) return null
      if (row.status === 'running') {
        await client.query(
          `UPDATE agent_run_attempts SET status = 'lease_lost', error_code = 'lease_lost', finished_at = $2
           WHERE run_id = $1 AND attempt_number = $3 AND status = 'running'`, [row.id, now, row.attempt_count],
        )
      }
      const claimed = await client.query<AgentRunRow>(
        `UPDATE agent_runs SET status = 'running', attempt_count = attempt_count + 1, lease_owner = $2,
          lease_expires_at = $3, updated_at = $1 WHERE id = $4 RETURNING *`,
        [now, workerId, new Date(now.getTime() + Math.max(1, leaseMs)), row.id],
      )
      await client.query(
        `INSERT INTO agent_run_attempts(run_id, attempt_number, worker_id, started_at, status)
         VALUES ($1,$2,$3,$4,'running')`, [row.id, claimed.rows[0]!.attempt_count, workerId, now],
      )
      return runFromRow(claimed.rows[0]!)
    })
  }

  async renewLease(runId: string, workerId: string, now: Date, leaseMs: number): Promise<{ owned: boolean; cancelRequested: boolean }> {
    const result = await this.pool.query<{ cancel_requested_at: Date | null }>(
      `UPDATE agent_runs SET lease_expires_at = $4, updated_at = $3
       WHERE id = $1 AND status = 'running' AND lease_owner = $2 AND lease_expires_at > $3
       RETURNING cancel_requested_at`, [runId, workerId, now, new Date(now.getTime() + Math.max(1, leaseMs))],
    )
    if (result.rows[0]) return { owned: true, cancelRequested: result.rows[0].cancel_requested_at !== null }
    const current = await this.pool.query<{ cancel_requested_at: Date | null }>('SELECT cancel_requested_at FROM agent_runs WHERE id = $1', [runId])
    return { owned: false, cancelRequested: current.rows[0]?.cancel_requested_at !== null }
  }

  async requestCancellation(outlineId: string, runId: string, now: Date): Promise<AgentRunRecord> {
    const result = await this.pool.query<AgentRunRow>(
      `UPDATE agent_runs SET cancel_requested_at = COALESCE(cancel_requested_at, $3),
        status = CASE WHEN status IN ('queued','retry_wait') THEN 'cancelled' ELSE status END,
        updated_at = $3
       WHERE outline_id = $1 AND id = $2 RETURNING *`, [outlineId, runId, now],
    )
    if (!result.rows[0]) throw new AgentStoreError('not_found', 'Run is unavailable.')
    return runFromRow(result.rows[0])
  }

  async finishCancelled(runId: string, workerId: string): Promise<void> {
    await this.settleAttempt(runId, workerId, 'cancelled', null, 'cancelled')
  }

  async fail(runId: string, workerId: string, errorCode: string, retryable: boolean, now: Date, backoffMs: number): Promise<AgentRunRecord> {
    return this.transaction(async (client) => {
      const locked = await requireLease(client, runId, workerId)
      const cancelled = locked.cancel_requested_at !== null
      const retry = !cancelled && retryable && locked.attempt_count < locked.max_attempts
      const status = cancelled ? 'cancelled' : retry ? 'retry_wait' : 'failed'
      const publicError = cancelled ? null : (!retry && locked.attempt_count >= locked.max_attempts ? 'attempts_exhausted' : errorCode)
      const result = await client.query<AgentRunRow>(
        `UPDATE agent_runs SET status = $2, error_code = $3, available_at = $4,
          lease_owner = NULL, lease_expires_at = NULL, updated_at = $5 WHERE id = $1 RETURNING *`,
        [runId, status, publicError, new Date(now.getTime() + (retry ? Math.max(0, backoffMs) : 0)), now],
      )
      await client.query(
        `UPDATE agent_run_attempts SET status = $3, error_code = $4, finished_at = $5
         WHERE run_id = $1 AND attempt_number = $2`,
        [runId, locked.attempt_count, cancelled ? 'cancelled' : 'failed', publicError, now],
      )
      return runFromRow(result.rows[0]!)
    })
  }

  async complete(runId: string, workerId: string, resultIdentity: string, result: AgentRunResult): Promise<AgentRunResult> {
    return this.transaction(async (client) => {
      const existing = await client.query<ResultRow>('SELECT * FROM agent_run_results WHERE run_id = $1', [runId])
      if (existing.rows[0]) {
        const current = resultFromRow(existing.rows[0])
        if (existing.rows[0].result_identity === resultIdentity && JSON.stringify(current) === JSON.stringify(result)) return current
        throw new AgentStoreError('conflict', 'Run already has a different result.')
      }
      const locked = await requireLease(client, runId, workerId)
      if (locked.cancel_requested_at) throw new AgentStoreError('invalid_state', 'Run cancellation was requested.')
      await client.query(
        `INSERT INTO agent_run_results(run_id, result_identity, first_revision, last_revision, root_note_ids)
         VALUES ($1,$2,$3,$4,$5)`, [runId, resultIdentity, result.firstRevision, result.lastRevision, result.rootNoteIds],
      )
      await client.query(
        `UPDATE agent_run_attempts SET status = 'completed', finished_at = now()
         WHERE run_id = $1 AND attempt_number = $2`, [runId, locked.attempt_count],
      )
      await client.query(
        `UPDATE agent_runs SET status = 'completed', error_code = NULL, lease_owner = NULL,
          lease_expires_at = NULL, updated_at = now() WHERE id = $1`, [runId],
      )
      return structuredClone(result)
    })
  }

  async retry(outlineId: string, runId: string, input: RunInput, maxAttempts: number): Promise<AgentRunRecord> {
    const previous = await this.getRun(outlineId, runId)
    if (!previous) throw new AgentStoreError('not_found', 'Run is unavailable.')
    if (!['failed', 'cancelled', 'interrupted'].includes(previous.status)) throw new AgentStoreError('invalid_state', 'Run cannot be retried.')
    const owner = await this.pool.query<{ owner_id: string }>('SELECT owner_id FROM agent_runs WHERE id = $1', [runId])
    return this.admitRun({
      input, trigger: previous.trigger, triggerIdentity: `retry:${runId}:${input.runId}`,
      policyId: previous.policyId ?? undefined, maxAttempts, retryOfRunId: runId, ownerId: owner.rows[0]!.owner_id,
    })
  }

  private async settleAttempt(runId: string, workerId: string, status: 'cancelled', errorCode: string | null, runStatus: 'cancelled'): Promise<void> {
    await this.transaction(async (client) => {
      const locked = await requireLease(client, runId, workerId)
      await client.query('UPDATE agent_run_attempts SET status = $3, error_code = $4, finished_at = now() WHERE run_id = $1 AND attempt_number = $2', [runId, locked.attempt_count, status, errorCode])
      await client.query('UPDATE agent_runs SET status = $2, error_code = $3, lease_owner = NULL, lease_expires_at = NULL, updated_at = now() WHERE id = $1', [runId, runStatus, errorCode])
    })
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try { await client.query('BEGIN'); const result = await operation(client); await client.query('COMMIT'); return result }
    catch (error) { await client.query('ROLLBACK'); throw error }
    finally { client.release() }
  }
}

interface AgentRunRow extends QueryResultRow {
  id: string; owner_id: string; outline_id: string; trigger_kind: AgentRunRecord['trigger']; trigger_identity: string
  input_snapshot: unknown; definition_snapshot: { policyId?: string | null }; configuration_revision: string
  credential_reference: string; status: string; attempt_count: number; max_attempts: number; available_at: Date
  lease_owner: string | null; lease_expires_at: Date | null; cancel_requested_at: Date | null; error_code: string | null
  retry_of_run_id: string | null; created_at: Date; updated_at: Date
  first_revision?: string | null; last_revision?: string | null; root_note_ids?: string[] | null
}

interface ResultRow extends QueryResultRow { result_identity: string; first_revision: string; last_revision: string; root_note_ids: string[] }

function runFromRow(row: AgentRunRow): AgentRunRecord {
  const input = runInputSchema.parse(row.input_snapshot)
  return {
    id: row.id, outlineId: row.outline_id, trigger: row.trigger_kind, triggerIdentity: row.trigger_identity,
    ownerId: row.owner_id,
    input, skillId: input.skill.id, policyId: row.definition_snapshot.policyId ?? null,
    configurationRevision: Number(row.configuration_revision), credentialReference: row.credential_reference,
    status: runStatusSchema.parse(row.status), attemptCount: row.attempt_count, maxAttempts: row.max_attempts,
    availableAt: row.available_at.toISOString(), leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at?.toISOString() ?? null,
    cancelRequestedAt: row.cancel_requested_at?.toISOString() ?? null, errorCode: row.error_code,
    retryOfRunId: row.retry_of_run_id, admittedAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
    result: row.first_revision && row.last_revision && row.root_note_ids
      ? { firstRevision: Number(row.first_revision), lastRevision: Number(row.last_revision), rootNoteIds: row.root_note_ids }
      : null,
  }
}

function resultFromRow(row: ResultRow): AgentRunResult {
  return { firstRevision: Number(row.first_revision), lastRevision: Number(row.last_revision), rootNoteIds: row.root_note_ids }
}

async function lockOutline(client: PoolClient, outlineId: string): Promise<void> {
  const result = await client.query('SELECT id FROM outlines WHERE id = $1 FOR UPDATE', [outlineId])
  if (!result.rowCount) throw new AgentStoreError('not_found', 'Outline is unavailable.')
}

async function currentRevision(client: PoolClient, table: 'agent_configuration_revisions' | 'agent_automation_revisions', outlineId: string): Promise<number> {
  const result = await client.query<{ revision: string }>(`SELECT revision FROM ${table} WHERE outline_id = $1 ORDER BY revision DESC LIMIT 1`, [outlineId])
  return Number(result.rows[0]?.revision ?? 0)
}

async function requireLease(client: PoolClient, runId: string, workerId: string): Promise<AgentRunRow> {
  const result = await client.query<AgentRunRow>('SELECT * FROM agent_runs WHERE id = $1 FOR UPDATE', [runId])
  const row = result.rows[0]
  if (!row || row.status !== 'running' || row.lease_owner !== workerId) throw new AgentStoreError('lease_lost', 'Worker no longer owns the run lease.')
  return row
}
