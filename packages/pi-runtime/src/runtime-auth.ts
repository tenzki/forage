import { ModelRuntime, resolveCliModel } from '@earendil-works/pi-coding-agent'
import { InMemoryCredentialStore, type ModelsStore, type ModelsStoreEntry } from '@earendil-works/pi-ai'
import { registerBunOAuthFlows } from '@earendil-works/pi-ai/bun-oauth'

registerBunOAuthFlows()

/** The two credential shapes both environments resolve: an OpenAI API key or a ChatGPT subscription token. */
export type ModelAuth =
  | { providerId: 'openai'; accessToken: string }
  | {
    providerId: 'openai-codex'
    accessToken: string
    accountId: string
    expires: number
  }

/** A model runtime holding only in-memory credentials; nothing is read from or written to disk. */
export async function createAuthenticatedModelRuntime(auth: ModelAuth): Promise<ModelRuntime> {
  const accessToken = auth.accessToken.trim()
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
  })
  if (auth.providerId === 'openai') {
    await runtime.setRuntimeApiKey(auth.providerId, accessToken)
  }
  return runtime
}

/** Resolve `<provider>/<model>` against the runtime's catalog, failing when the model is unavailable. */
export function resolveModel(runtime: ModelRuntime, providerId: string, modelId: string) {
  const resolved = resolveCliModel({ cliModel: `${providerId}/${modelId}`, modelRuntime: runtime })
  if (resolved.error || !resolved.model) throw new Error(`Model not available: ${resolved.error ?? modelId}`)
  return { model: resolved.model, warning: resolved.warning }
}
