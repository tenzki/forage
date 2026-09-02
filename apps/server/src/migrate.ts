import { readdir, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Pool } from 'pg'
import { loadServerConfig } from './config.js'

export interface SqlMigration {
  name: string
  sql: string
}

export async function loadMigrations(directory: string): Promise<SqlMigration[]> {
  const names = (await readdir(directory))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort((left, right) => left.localeCompare(right))
  return Promise.all(names.map(async (name) => ({
    name,
    sql: await readFile(resolve(directory, name), 'utf8'),
  })))
}

export async function migrate(databaseUrl: string, directory: string): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 })
  try {
    for (const migration of await loadMigrations(directory)) await pool.query(migration.sql)
  } finally {
    await pool.end()
  }
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === entry) {
  const config = loadServerConfig(process.env)
  const directory = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations')
  await migrate(config.databaseUrl, directory)
}
