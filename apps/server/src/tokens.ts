import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { z } from 'zod'
import { loadServerConfig } from './config.js'

const args = new Map<string, string>()
for (let index = 3; index < process.argv.length; index += 2) {
  args.set(process.argv[index]?.replace(/^--/, ''), process.argv[index + 1] ?? '')
}
const action = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : ''
const config = loadServerConfig(process.env)
const pool = new Pool({ connectionString: config.databaseUrl, max: 1 })

try {
  if (action === 'list') {
    const result = await pool.query(
      `SELECT id, kind, name, scopes, expires_at, revoked_at, last_used_at, created_at
       FROM credentials ORDER BY created_at`,
    )
    process.stdout.write(`${JSON.stringify(result.rows, null, 2)}\n`)
  } else if (action === 'revoke') {
    const id = z.string().min(1).parse(process.argv[3])
    const result = await pool.query('UPDATE credentials SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [id])
    if (!result.rowCount) throw new Error('Credential was not found or was already revoked.')
    process.stdout.write(`Revoked ${id}\n`)
  } else if (action === 'create') {
    const kind = z.enum(['api', 'device']).parse(args.get('kind') ?? 'api')
    const name = z.string().trim().min(1).max(200).parse(args.get('name'))
    const scope = z.enum(['notes:create', 'sync']).parse(args.get('scope') ?? (kind === 'api' ? 'notes:create' : 'sync'))
    const expiresAt = args.get('expires') ? z.iso.datetime({ offset: true }).parse(args.get('expires')) : null
    const binding = await pool.query<{ owner_id: string; id: string }>(
      `SELECT owner_id, id FROM outlines WHERE ($1::text IS NULL OR id = $1) ORDER BY created_at LIMIT 1`,
      [args.get('outline') || null],
    )
    if (!binding.rows[0]) throw new Error('No matching outline exists. Bootstrap the server first.')
    const secret = `fg_${kind}_${randomBytes(32).toString('base64url')}`
    const id = `token_${randomUUID()}`
    await pool.query(
      `INSERT INTO credentials(id, owner_id, outline_id, kind, name, secret_hash, scopes, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, binding.rows[0].owner_id, binding.rows[0].id, kind, name,
        createHash('sha256').update(secret).digest('hex'), [scope], expiresAt],
    )
    process.stdout.write(`${JSON.stringify({ id, token: secret, scope, expiresAt, warning: 'This token is displayed once.' }, null, 2)}\n`)
  } else {
    throw new Error('Usage: tokens.ts create --kind api --name NAME [--scope notes:create] [--outline ID] [--expires ISO] | revoke ID | list')
  }
} finally {
  await pool.end()
}
