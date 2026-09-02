// @vitest-environment node
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadMigrations } from './migrate'

describe('server migration discovery', () => {
  it('loads only numbered SQL migrations in deterministic filename order', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'forage-migrations-'))
    await Promise.all([
      writeFile(join(directory, '0002_second.sql'), 'SELECT 2;'),
      writeFile(join(directory, '0001_first.sql'), 'SELECT 1;'),
      writeFile(join(directory, 'README.md'), 'ignored'),
    ])
    await expect(loadMigrations(directory)).resolves.toEqual([
      { name: '0001_first.sql', sql: 'SELECT 1;' },
      { name: '0002_second.sql', sql: 'SELECT 2;' },
    ])
  })
})
