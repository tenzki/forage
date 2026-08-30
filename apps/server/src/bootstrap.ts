import { Pool } from 'pg'
import { z } from 'zod'
import { loadServerConfig } from './config.js'
import { PostgresServerRepository } from './postgres.js'

const email = z.string().email().parse(process.env.FORAGE_OWNER_EMAIL)
const config = loadServerConfig(process.env)
const pool = new Pool({ connectionString: config.databaseUrl, max: 1 })
try {
  const repository = new PostgresServerRepository(pool, { instanceId: config.instanceId })
  const result = await repository.bootstrapOwner(email)
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
} finally {
  await pool.end()
}
