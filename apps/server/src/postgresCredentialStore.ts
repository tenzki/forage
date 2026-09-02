import type { Pool, PoolClient, QueryResultRow } from 'pg'
import { CredentialServiceError, type ProviderCredentialRecord, type ProviderCredentialStore } from './credentialService.js'

export class PostgresProviderCredentialStore implements ProviderCredentialStore {
  constructor(private readonly pool: Pool) {}

  async insert(record: ProviderCredentialRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_provider_credentials
       (id, owner_id, outline_id, provider, status, ciphertext, nonce, key_version, account_label, expires_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, values(record),
    )
  }

  async get(id: string): Promise<ProviderCredentialRecord | null> {
    const result = await this.pool.query<CredentialRow>('SELECT * FROM agent_provider_credentials WHERE id = $1', [id])
    return result.rows[0] ? fromRow(result.rows[0]) : null
  }

  async mutate<T>(id: string, operation: (record: ProviderCredentialRecord) => Promise<{ record: ProviderCredentialRecord; result: T }>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const selected = await client.query<CredentialRow>('SELECT * FROM agent_provider_credentials WHERE id = $1 FOR UPDATE', [id])
      if (!selected.rows[0]) throw new CredentialServiceError('authentication_required', 'Credential is unavailable.')
      const changed = await operation(fromRow(selected.rows[0]))
      await update(client, changed.record)
      await client.query('COMMIT')
      return changed.result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally { client.release() }
  }
}

interface CredentialRow extends QueryResultRow {
  id: string; owner_id: string; outline_id: string; provider: ProviderCredentialRecord['provider']; status: ProviderCredentialRecord['status']
  ciphertext: Buffer | null; nonce: Buffer | null; key_version: number | null; account_label: string | null
  expires_at: Date | null; created_at: Date; updated_at: Date
}

function fromRow(row: CredentialRow): ProviderCredentialRecord {
  return {
    id: row.id, ownerId: row.owner_id, outlineId: row.outline_id, provider: row.provider, status: row.status,
    encrypted: row.ciphertext && row.nonce && row.key_version
      ? { ciphertext: row.ciphertext.toString('base64'), nonce: row.nonce.toString('base64'), keyVersion: row.key_version }
      : null,
    ...(row.account_label ? { accountLabel: row.account_label } : {}),
    ...(row.expires_at ? { expiresAt: row.expires_at.toISOString() } : {}),
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  }
}

function values(record: ProviderCredentialRecord): unknown[] {
  return [record.id, record.ownerId, record.outlineId, record.provider, record.status,
    record.encrypted ? Buffer.from(record.encrypted.ciphertext, 'base64') : null,
    record.encrypted ? Buffer.from(record.encrypted.nonce, 'base64') : null,
    record.encrypted?.keyVersion ?? null, record.accountLabel ?? null, record.expiresAt ?? null,
    record.createdAt, record.updatedAt]
}

async function update(client: PoolClient, record: ProviderCredentialRecord): Promise<void> {
  const all = values(record)
  await client.query(
    `UPDATE agent_provider_credentials SET owner_id=$2, outline_id=$3, provider=$4, status=$5,
      ciphertext=$6, nonce=$7, key_version=$8, account_label=$9, expires_at=$10,
      created_at=$11, updated_at=$12 WHERE id=$1`, all,
  )
}
