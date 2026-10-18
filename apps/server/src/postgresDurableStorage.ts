import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { JournalStorage, type JournalCommit } from '@forage/pi-runtime'
import { AgentStoreError, type DurableExecutionStore } from './agentStore.js'

const MAX_JOURNAL_BYTES = 32 * 1024 * 1024

/** Every allocation and checkpoint is fenced by run attempt, expiry, and an execution nonce. */
export async function openPostgresDurableExecution(pool: Pool, runId: string, workerId: string): Promise<DurableExecutionStore> {
  const nonce = randomUUID()
  const owner = await transaction(async (client) => {
    const result = await client.query<{ outline_id: string; call_id: string | null; attempt_count: number }>(
      `SELECT outline_id,call_id,attempt_count FROM agent_runs WHERE id=$1 AND lease_owner=$2
       AND status='running' AND lease_expires_at > clock_timestamp() FOR UPDATE`, [runId, workerId],
    )
    const run = result.rows[0]
    if (!run) throw lost()
    const callId = run.call_id ?? runId
    await client.query(
      `INSERT INTO agent_durable_calls(outline_id,call_id,origin_run_id,owner_nonce) VALUES ($1,$2,$3,$4)
       ON CONFLICT (outline_id,call_id) DO UPDATE SET owner_nonce=EXCLUDED.owner_nonce,updated_at=now()`,
      [run.outline_id, callId, run.call_id ?? runId, nonce],
    )
    return { outlineId: run.outline_id, callId, attempt: run.attempt_count }
  })

  const fenced = async <T>(work: (client: PoolClient) => Promise<T>): Promise<T> => transaction(async (client) => {
    const run = await client.query(
      `SELECT id FROM agent_runs WHERE id=$1 AND lease_owner=$2 AND attempt_count=$3
       AND status='running' AND lease_expires_at > clock_timestamp() FOR UPDATE`, [runId, workerId, owner.attempt],
    )
    if (!run.rowCount) throw lost()
    const call = await client.query(
      'SELECT call_id FROM agent_durable_calls WHERE outline_id=$1 AND call_id=$2 AND owner_nonce=$3 FOR UPDATE',
      [owner.outlineId, owner.callId, nonce],
    )
    if (!call.rowCount) throw lost()
    return work(client)
  })
  const assertOwnership = async () => { await fenced(async () => undefined) }
  const storage = await JournalStorage.open({
    load: () => fenced(async (client) => {
      const result = await client.query<{ sequence: string; writes: JournalCommit['writes'] }>(
        'SELECT sequence,writes FROM agent_durable_commits WHERE outline_id=$1 AND call_id=$2 ORDER BY sequence',
        [owner.outlineId, owner.callId],
      )
      return result.rows.map((row) => ({ sequence: Number(row.sequence), writes: row.writes }))
    }),
    mintId: (minimum) => fenced(async (client) => {
      const result = await client.query<{ id: string }>(
        'UPDATE agent_durable_calls SET next_id=GREATEST(next_id,$3)+1 WHERE outline_id=$1 AND call_id=$2 RETURNING next_id-1 AS id',
        [owner.outlineId, owner.callId, minimum],
      )
      const id = Number(result.rows[0]!.id)
      if (!Number.isSafeInteger(id)) throw new Error('Durable identifier limit exceeded.')
      return id
    }),
    append: (commit) => fenced(async (client) => {
      const encoded = JSON.stringify(commit.writes)
      const result = await client.query(
        `UPDATE agent_durable_calls SET sequence=$3,journal_bytes=journal_bytes+$4,updated_at=now()
         WHERE outline_id=$1 AND call_id=$2 AND sequence=$3-1 AND journal_bytes+$4 <= $5`,
        [owner.outlineId, owner.callId, commit.sequence, Buffer.byteLength(encoded), MAX_JOURNAL_BYTES],
      )
      if (!result.rowCount) throw new Error('Conversation checkpoint budget or sequence limit exceeded.')
      await client.query('INSERT INTO agent_durable_commits(outline_id,call_id,sequence,writes) VALUES ($1,$2,$3,$4)',
        [owner.outlineId, owner.callId, commit.sequence, encoded])
    }),
    close: async () => undefined,
  })
  return { storage, assertOwnership }

  async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await work(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }
}
function lost() { return new AgentStoreError('lease_lost', 'Worker no longer owns durable execution.') }
