import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { loadServerConfig } from './config.js'

const config = loadServerConfig(process.env)
const pool = new Pool({ connectionString: config.databaseUrl, max: 1 })
try {
  const migration = await readFile(new URL('../migrations/0001_server.sql', import.meta.url), 'utf8')
  await pool.query(migration)
} finally {
  await pool.end()
}
