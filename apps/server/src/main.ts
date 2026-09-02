import { Pool } from 'pg'
import { buildServer } from './app.js'
import { loadServerConfig, publicConfigForLogging } from './config.js'
import { PostgresServerRepository } from './postgres.js'
import { FileSystemAssetStorage } from './assets.js'
import { PostgresProviderCredentialStore } from './postgresCredentialStore.js'
import { ServerCredentialService } from './credentialService.js'
import { BoundedPublicReader, createServerToolRegistry, DuckDuckGoSearchProvider } from './serverTools.js'
import { SupadataTranscriptProvider } from './transcript.js'
import { OpenAIResponsesDispatcherClassifier, OpenAIResponsesModelAdapter } from './serverModel.js'
import { ServerAgentRunner, ServerAgentWorker } from './serverRunner.js'
import { OpenAIImageAssetGenerator } from './imageGeneration.js'

const config = loadServerConfig(process.env)
const pool = new Pool({ connectionString: config.databaseUrl, max: 10 })
const credentialService = config.agent.encryptionKeys.length ? new ServerCredentialService(new PostgresProviderCredentialStore(pool), {
  encryptionKeys: config.agent.encryptionKeys,
  ...(config.agent.oauth.clientId ? { oauth: {
    deviceUrl: config.agent.oauth.deviceUrl, tokenUrl: config.agent.oauth.tokenUrl, clientId: config.agent.oauth.clientId,
  } } : {}),
}) : undefined
const transcript = config.agent.supadata ? new SupadataTranscriptProvider({
  apiUrl: config.agent.supadata.apiUrl, apiKey: config.agent.supadata.apiKey,
  deadlineMs: config.agent.oauth.timeoutSeconds * 1_000,
}) : undefined
const reader = new BoundedPublicReader()
const webSearch = new DuckDuckGoSearchProvider()
const assetStorage = new FileSystemAssetStorage(config.assetDir)
const tools = createServerToolRegistry({
  reader, webSearch: (query, signal) => webSearch.search(query, signal), ...(transcript ? { transcript } : {}),
  outlineSearch: async () => [],
  ...(credentialService ? { imageGeneration: async () => ({ available: true }) } : {}),
})
const repository = new PostgresServerRepository(pool, {
  instanceId: config.instanceId, supportedAgentToolIds: tools.map((tool) => tool.id),
  agentMaxAttempts: config.agent.worker.maxAttempts,
  ...(credentialService ? { dispatcherForAgent: async ({ ownerId, outlineId, agent }) => {
    if (!agent.credentialRef) return undefined
    const credential = await credentialService.resolve(agent.credentialRef, ownerId, outlineId)
    return new OpenAIResponsesDispatcherClassifier({ credential, modelId: agent.modelId })
  } } : {}),
})
const app = buildServer({
  repository,
  ...(credentialService ? { credentialService } : {}),
  supportedAgentToolIds: tools.map((tool) => tool.id),
  agentMaxAttempts: config.agent.worker.maxAttempts,
  assetStorage,
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    redact: ['req.headers.authorization', 'req.headers.cookie', 'headers.authorization'],
  },
})
const workerId = `worker_${config.instanceId}_${process.pid}`.slice(0, 128)
const runner = credentialService ? new ServerAgentRunner({
  repository, credentials: credentialService,
  tools: (run, credential) => createServerToolRegistry({
    reader, webSearch: (query, signal) => webSearch.search(query, signal), ...(transcript ? { transcript } : {}),
    outlineSearch: (query) => repository.searchOutline(run.outlineId, query),
    imageGeneration: (prompt, signal) => new OpenAIImageAssetGenerator({
      repository, storage: assetStorage, credential,
      principal: {
        tokenId: workerId, ownerId: run.ownerId, outlineId: run.outlineId, kind: 'device',
        scopes: ['agents:read', 'agents:execute'],
      },
    }).generate(prompt, signal),
  }),
  workerId,
  leaseMs: config.agent.worker.leaseSeconds * 1_000,
  maxBackoffMs: config.agent.worker.maxBackoffSeconds * 1_000,
  modelFactory: (credential, run) => new OpenAIResponsesModelAdapter({ credential, modelId: run.input.agent.modelId }),
}) : null
const worker = runner ? new ServerAgentWorker({
  store: repository.agentStore, runner, workerId,
  concurrency: config.agent.worker.concurrency, pollMs: config.agent.worker.pollMs,
  leaseMs: config.agent.worker.leaseSeconds * 1_000,
}) : null

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void (worker?.stop() ?? Promise.resolve()).then(() => app.close()).then(() => pool.end()).finally(() => process.exit(0))
  })
}

await app.listen({ host: config.host, port: config.port })
if (config.agent.worker.enabled) worker!.start()
app.log.info({ config: publicConfigForLogging(config) }, 'Forage server started')
