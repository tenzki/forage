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
import { PostgresOutlineChangeNotifier } from './outlineStream.js'
import { loadBackendMcp } from './mcp.js'

const config = loadServerConfig(process.env)
const discoveredMcp = await loadBackendMcp(process.env.FORAGE_MCP_CONFIG)
const mcp = config.agent.engine === 'pi' ? discoveredMcp : {
  connections: [],
  inventory: discoveredMcp.inventory.map((connection) => ({ ...connection, enabled: false, error: 'MCP tools require the Pi agent engine.' })),
}
const mcpToolIds = mcp.inventory.filter((connection) => connection.enabled && !connection.error).flatMap((connection) => connection.tools.map((tool) => tool.id))
const pool = new Pool({ connectionString: config.databaseUrl, max: 10 })
const credentialService = new ServerCredentialService(new PostgresProviderCredentialStore(pool), {
  encryptionKeys: config.agent.encryptionKeys,
  oauth: config.agent.oauth,
})
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
  imageGeneration: async () => ({ available: true }),
})
const repository = new PostgresServerRepository(pool, {
  instanceId: config.instanceId, supportedAgentToolIds: [...tools.map((tool) => tool.id), ...mcpToolIds],
  mcpInventory: mcp.inventory,
  agentMaxAttempts: config.agent.worker.maxAttempts,
  dispatcherForAgent: async ({ ownerId, outlineId, agent }) => {
    if (!agent.credentialRef) return undefined
    const credential = await credentialService.resolve(agent.credentialRef, ownerId, outlineId)
    return new OpenAIResponsesDispatcherClassifier({ credential, modelId: agent.modelId })
  },
})
await repository.reconcileNoteProjections()
const outlineChangeNotifier = new PostgresOutlineChangeNotifier(
  config.databaseUrl,
  (error) => app.log.error({ error }, 'Outline change notifications interrupted'),
)
const app = buildServer({
  repository,
  outlineChangeNotifier,
  credentialService,
  supportedAgentToolIds: [...tools.map((tool) => tool.id), ...mcpToolIds],
  mcpInventory: mcp.inventory,
  agentMaxAttempts: config.agent.worker.maxAttempts,
  agentEngine: config.agent.engine,
  conversationBudgetBytes: config.agent.conversations.maxBytes,
  assetStorage,
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    redact: ['req.headers.authorization', 'req.headers.cookie', 'headers.authorization'],
  },
})
await outlineChangeNotifier.start()
const workerId = `worker_${config.instanceId}_${process.pid}`.slice(0, 128)
const runner = new ServerAgentRunner({
  mcpConnections: mcp.connections,
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
  engine: config.agent.engine,
  modelFactory: (credential, run) => new OpenAIResponsesModelAdapter({ credential, modelId: run.input.agent.modelId }),
})
const worker = new ServerAgentWorker({
  store: repository.agentStore, runner, workerId,
  concurrency: config.agent.worker.concurrency, pollMs: config.agent.worker.pollMs,
  leaseMs: config.agent.worker.leaseSeconds * 1_000,
})

// Finished call transcripts past the age limit are deleted; replies to those calls then start over.
const pruneConversations = async () => {
  try {
    const before = new Date(Date.now() - config.agent.conversations.maxAgeDays * 86_400_000)
    const pruned = await repository.agentStore.pruneConversations(before)
    if (pruned) app.log.info({ pruned }, 'Pruned expired call transcripts')
  } catch (error) {
    app.log.error({ error }, 'Pruning call transcripts failed')
  }
}
const pruneTimer = setInterval(() => { void pruneConversations() }, 60 * 60 * 1_000)
pruneTimer.unref()

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    clearInterval(pruneTimer)
    void worker.stop()
      .then(() => app.close())
      .then(() => outlineChangeNotifier.close())
      .then(() => pool.end())
      .finally(() => process.exit(0))
  })
}

await app.listen({ host: config.host, port: config.port })
worker.start()
void pruneConversations()
app.log.info({ config: publicConfigForLogging(config) }, 'Forage server started')
