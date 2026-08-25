import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { InMemoryCredentialStore } from '@earendil-works/pi-ai'

export type SidecarAuth =
  | { providerId: 'openai'; accessToken: string }
  | {
    providerId: 'openai-codex'
    accessToken: string
    accountId: string
    expires: number
  }

export async function createAuthenticatedModelRuntime(auth: SidecarAuth): Promise<ModelRuntime> {
  const accessToken = auth.accessToken.trim()
  if (!accessToken) throw new Error('Missing AI_CHAT_API_KEY environment variable.')

  const credentials = new InMemoryCredentialStore()
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
    allowModelNetwork: false,
    modelRefreshTimeoutMs: 5_000,
  })
  if (auth.providerId === 'openai') {
    await runtime.setRuntimeApiKey(auth.providerId, accessToken)
  }
  return runtime
}
