import { Pool } from 'pg'
import { buildServer } from './app.js'
import { loadServerConfig, publicConfigForLogging } from './config.js'
import { PostgresServerRepository } from './postgres.js'
import { FileSystemAssetStorage } from './assets.js'

const config = loadServerConfig(process.env)
const pool = new Pool({ connectionString: config.databaseUrl, max: 10 })
const repository = new PostgresServerRepository(pool, { instanceId: config.instanceId })
const app = buildServer({
  repository,
  assetStorage: new FileSystemAssetStorage(config.assetDir),
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    redact: ['req.headers.authorization', 'req.headers.cookie', 'headers.authorization'],
  },
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(() => pool.end()).finally(() => process.exit(0))
  })
}

await app.listen({ host: config.host, port: config.port })
app.log.info({ config: publicConfigForLogging(config) }, 'Forage server started')
