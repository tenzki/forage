import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { InMemoryCredentialStore, type ModelsStore, type ModelsStoreEntry } from '@earendil-works/pi-ai'
import { registerBunOAuthFlows } from '@earendil-works/pi-ai/bun-oauth'
import { apiKeyProviderSchema, modelProviderSchema, type ApiKeyProvider, type ModelProvider } from '@forage/agent-runtime'

registerBunOAuthFlows()
const admittedProviders = new WeakMap<ModelRuntime, ModelProvider>()

/** The two credential shapes both environments resolve: an OpenAI API key or a ChatGPT subscription token. */
export type ModelAuth =
  | { providerId: ApiKeyProvider; accessToken: string }
  | {
    providerId: 'openai-codex'
    accessToken: string
    accountId: string
    expires: number
  }

/** A model runtime holding only in-memory credentials; nothing is read from or written to disk. */
export async function createAuthenticatedModelRuntime(auth: ModelAuth): Promise<ModelRuntime> {
  const accessToken = auth.accessToken.trim()
  modelProviderSchema.parse(auth.providerId)
  if (!accessToken) throw new Error('Missing model access token.')

  const credentials = new InMemoryCredentialStore()
  const modelEntries = new Map<string, ModelsStoreEntry>()
  const modelsStore: ModelsStore = {
    read: async (providerId) => modelEntries.get(providerId),
    write: async (providerId, entry) => { modelEntries.set(providerId, entry) },
    delete: async (providerId) => { modelEntries.delete(providerId) },
  }
  if (auth.providerId === 'openai-codex') {
    if (!auth.accountId.trim() || !Number.isFinite(auth.expires) || auth.expires <= Date.now()) {
      throw new Error('Missing or invalid ChatGPT OAuth account ID or expiry.')
    }
    await credentials.modify(auth.providerId, async () => ({
      type: 'oauth',
      access: accessToken,
      refresh: '',
      expires: auth.expires,
      accountId: auth.accountId.trim(),
    }))
  }

  const runtime = await ModelRuntime.create({
    credentials,
    modelsStore,
    allowModelNetwork: false,
    modelRefreshTimeoutMs: 5_000,
    refreshOnCreate: false,
  })
  for (const provider of runtime.getProviders()) {
    if (provider.id === auth.providerId) continue
    runtime.registerNativeProvider({ ...provider, auth: {
      apiKey: { name: 'Unavailable in this run', login: async () => { throw new Error('Provider is not admitted.') }, resolve: async () => undefined },
    } })
  }
  if (apiKeyProviderSchema.safeParse(auth.providerId).success) {
    await runtime.setRuntimeApiKey(auth.providerId, accessToken)
  }
  await runtime.refresh({ allowNetwork: false })
  admittedProviders.set(runtime, auth.providerId)
  return runtime
}

/** Resolve `<provider>/<model>` against the runtime's catalog, failing when the model is unavailable. */
export function resolveModel(runtime: ModelRuntime, providerId: string, modelId: string) {
  if (!modelProviderSchema.safeParse(providerId).success || admittedProviders.get(runtime) !== providerId) throw new Error('Model not available for the selected provider.')
  const model = runtime.getModel(providerId, modelId)
  if (!model || model.provider !== providerId || model.id !== modelId) throw new Error('Model not available for the selected provider.')
  return { model, warning: undefined }
}
