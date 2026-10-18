import { createModels, InMemoryCredentialStore, type Models } from '@earendil-works/pi-ai'
import { modelProviderSchema, type ApiKeyProvider, type ModelProvider } from '@forage/agent-runtime'
import { providerFactories } from './provider-catalog'

export type ModelRuntime = Models
const admittedProviders = new WeakMap<Models, ModelProvider>()

/** An admitted provider API key or short-lived ChatGPT subscription token. */
export type ModelAuth =
  | { providerId: ApiKeyProvider; accessToken: string }
  | {
    providerId: 'openai-codex'
    accessToken: string
    accountId: string
    expires: number
  }

/** Only the admitted provider is registered. Ambient environment and file auth are disabled. */
export async function createAuthenticatedModelRuntime(auth: ModelAuth): Promise<Models> {
  const accessToken = auth.accessToken.trim()
  modelProviderSchema.parse(auth.providerId)
  if (!accessToken) throw new Error('Missing model access token.')
  const credentials = new InMemoryCredentialStore()
  if (auth.providerId === 'openai-codex') {
    if (!auth.accountId.trim() || !Number.isFinite(auth.expires) || auth.expires <= Date.now()) {
      throw new Error('Missing or invalid ChatGPT OAuth account ID or expiry.')
    }
    await credentials.modify(auth.providerId, async () => ({
      type: 'oauth', access: accessToken, refresh: '', expires: auth.expires, accountId: auth.accountId.trim(),
    }))
  } else {
    await credentials.modify(auth.providerId, async () => ({ type: 'api_key', key: accessToken }))
  }
  const runtime = createModels({ credentials, authContext: { env: async () => undefined, fileExists: async () => false } })
  const provider = providerFactories[auth.providerId]()
  // Refresh belongs to the host. An expired short-lived token must never trigger an ambient login or refresh.
  if (auth.providerId === 'openai-codex' && provider.auth.oauth) {
    runtime.setProvider({ ...provider, auth: { oauth: {
      ...provider.auth.oauth,
      refresh: async () => { throw new Error('Model provider authentication is required.') },
    } } })
  } else runtime.setProvider(provider)
  admittedProviders.set(runtime, auth.providerId)
  return runtime
}

export function resolveModel(runtime: Models, providerId: string, modelId: string) {
  if (!modelProviderSchema.safeParse(providerId).success || admittedProviders.get(runtime) !== providerId) throw new Error('Model not available for the selected provider.')
  const model = runtime.getModel(providerId, modelId)
  if (!model || model.provider !== providerId || model.id !== modelId) throw new Error('Model not available for the selected provider.')
  return { model, warning: undefined }
}
