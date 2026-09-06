import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { z } from 'zod'
import { CliError, databaseUrl, readEnvironment, runCli } from './cli.js'

const USAGE = [
  'Usage:',
  '  tokens list',
  '  tokens create --kind api|device --name NAME [--scope notes:create|sync] [--outline ID] [--expires ISO]',
  '  tokens revoke CREDENTIAL_ID',
].join('\n')

function parse<T>(schema: z.ZodType<T>, value: unknown, hint: string): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    const detail = parsed.error.issues[0]?.message ?? 'Invalid argument'
    throw new CliError(`${detail.replace(/\.?$/, '.')} ${hint}`)
  }
  return parsed.data
}

await runCli(async () => {
  const args = new Map<string, string>()
  for (let index = 3; index < process.argv.length; index += 2) {
    args.set(process.argv[index]?.replace(/^--/, ''), process.argv[index + 1] ?? '')
  }
  const action = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : ''
  if (!['list', 'create', 'revoke'].includes(action)) throw new CliError(USAGE)

  const environment = readEnvironment(z.object({ DATABASE_URL: databaseUrl }))
  const pool = new Pool({ connectionString: environment.DATABASE_URL, max: 1 })
  try {
    if (action === 'list') {
      const result = await pool.query(
        `SELECT id, kind, name, scopes, expires_at, revoked_at, last_used_at, created_at
         FROM credentials ORDER BY created_at`,
      )
      if (!result.rowCount) {
        process.stdout.write('No credentials exist yet. Bootstrap the server with: npm run server:bootstrap\n')
        return
      }
      process.stdout.write(`${JSON.stringify(result.rows, null, 2)}\n`)
    } else if (action === 'revoke') {
      const id = parse(z.string().min(1), process.argv[3], 'Pass the credential id shown by "tokens list".')
      const result = await pool.query('UPDATE credentials SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [id])
      if (!result.rowCount) throw new CliError(`Credential ${id} was not found or was already revoked.`)
      process.stdout.write(`Revoked ${id}\n`)
    } else {
      const kind = parse(z.enum(['api', 'device']), args.get('kind') ?? 'api', 'Pass --kind api or --kind device.')
      const name = parse(z.string().trim().min(1).max(200), args.get('name'), 'Pass --name to label the token.')
      const scope = parse(
        z.enum(['notes:create', 'sync']),
        args.get('scope') ?? (kind === 'api' ? 'notes:create' : 'sync'),
        'Pass --scope notes:create or --scope sync.',
      )
      const expiresAt = args.get('expires')
        ? parse(z.iso.datetime({ offset: true }), args.get('expires'), 'Pass --expires as an ISO timestamp with offset.')
        : null
      const binding = await pool.query<{ owner_id: string; id: string }>(
        `SELECT owner_id, id FROM outlines WHERE ($1::text IS NULL OR id = $1) ORDER BY created_at LIMIT 1`,
        [args.get('outline') || null],
      )
      if (!binding.rows[0]) {
        throw new CliError(args.get('outline')
          ? `Outline ${args.get('outline')} does not exist. List outlines with "tokens list" or bootstrap the server first.`
          : 'No outline exists. Bootstrap the server first with: npm run server:bootstrap')
      }
      const secret = `fg_${kind}_${randomBytes(32).toString('base64url')}`
      const id = `token_${randomUUID()}`
      await pool.query(
        `INSERT INTO credentials(id, owner_id, outline_id, kind, name, secret_hash, scopes, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, binding.rows[0].owner_id, binding.rows[0].id, kind, name,
          createHash('sha256').update(secret).digest('hex'), [scope], expiresAt],
      )
      process.stdout.write(`${JSON.stringify({ id, token: secret, scope, expiresAt, warning: 'This token is displayed once.' }, null, 2)}\n`)
      if (kind === 'device') {
        process.stdout.write(
          'This token carries a single scope. Desktop server mode also needs agents:read, agents:execute, and agents:manage,\n'
          + 'which only "npm run server:bootstrap" issues.\n',
        )
      }
    }
  } finally {
    await pool.end()
  }
})
