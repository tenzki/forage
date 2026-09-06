import { Pool } from 'pg'
import { z } from 'zod'
import { CliError, databaseUrl, readEnvironment, runCli } from './cli.js'
import { PostgresServerRepository } from './postgres.js'

await runCli(async () => {
  const environment = readEnvironment(z.object({
    DATABASE_URL: databaseUrl,
    FORAGE_OWNER_EMAIL: z.string().email(),
    // Bootstrapping never reads the instance id; only the status endpoint reports it.
    FORAGE_INSTANCE_ID: z.string().trim().min(1).max(128).default('bootstrap'),
  }))
  const pool = new Pool({ connectionString: environment.DATABASE_URL, max: 1 })
  try {
    const repository = new PostgresServerRepository(pool, { instanceId: environment.FORAGE_INSTANCE_ID })
    const result = await repository.bootstrapOwner(environment.FORAGE_OWNER_EMAIL)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    process.stdout.write('The tokens are displayed once. Store them before closing this terminal.\n')
  } catch (error) {
    if (error instanceof Error && error.message.includes('already bootstrapped')) {
      throw new CliError([
        'This server already has an owner, so no new tokens were issued.',
        'List the existing credentials with:  npm run server:tokens -- list',
        'Mint a replacement with:            npm run server:tokens -- create --kind device --name desktop',
      ].join('\n'))
    }
    throw error
  } finally {
    await pool.end()
  }
})
