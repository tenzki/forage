import { apiKeyProviderSchema, type ModelProvider } from './providers'

export type ApiKeyProvider = Exclude<ModelProvider, 'openai-codex'>

export class ProviderConnectionError extends Error {
  constructor(public readonly code: 'authentication_required' | 'provider_rejected' | 'dependency_unavailable' | 'timeout', message: string) {
    super(message)
    this.name = 'ProviderConnectionError'
  }
}

const endpoints: Record<ApiKeyProvider, string> = {
  anthropic: 'https://api.anthropic.com/v1/models?limit=1',
  openrouter: 'https://openrouter.ai/api/v1/key',
  'opencode-go': 'https://opencode.ai/zen/go/v1/usage',
  openai: 'https://api.openai.com/v1/models',
}

export async function validateProviderConnection(
  provider: ApiKeyProvider,
  apiKey: string,
  options: { fetch?: typeof globalThis.fetch; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<void> {
  apiKeyProviderSchema.parse(provider)
  const key = apiKey.trim()
  if (!key || key.length > 512 || /[\r\n]/.test(key)) throw new ProviderConnectionError('authentication_required', 'Enter a valid provider API key.')
  const controller = new AbortController()
  const cancel = () => controller.abort('cancelled')
  const timeout = setTimeout(() => controller.abort('timeout'), Math.min(10_000, Math.max(1, options.timeoutMs ?? 10_000)))
  options.signal?.addEventListener('abort', cancel, { once: true })
  if (options.signal?.aborted) cancel()
  let rejectAbort: (reason: unknown) => void = () => undefined
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
  const onAbort = () => rejectAbort(controller.signal.reason === 'timeout'
    ? new ProviderConnectionError('timeout', 'Provider connection timed out. Try again.')
    : new DOMException('Provider connection cancelled.', 'AbortError'))
  controller.signal.addEventListener('abort', onAbort, { once: true })
  const request = async () => {
    if (controller.signal.aborted) onAbort()
    controller.signal.throwIfAborted()
    const response = await (options.fetch ?? globalThis.fetch)(endpoints[provider], {
      method: 'GET', redirect: 'error', signal: controller.signal,
      headers: provider === 'anthropic'
        ? { 'x-api-key': key, 'anthropic-version': '2023-06-01', accept: 'application/json' }
        : { authorization: `Bearer ${key}`, accept: 'application/json' },
    })
    if (!response.ok) {
      await response.body?.cancel()
      if (response.status === 401) throw new ProviderConnectionError('authentication_required', 'Provider rejected the API key. Check it and try again.')
      if (response.status === 403) throw new ProviderConnectionError('provider_rejected', 'This account is not authorized. Check provider access or subscription.')
      throw new ProviderConnectionError('dependency_unavailable', response.status === 429 ? 'Provider rate limit reached. Try again later.' : 'Provider is unavailable. Try again later.')
    }
    const reader = response.body?.getReader()
    if (!reader) throw new ProviderConnectionError('dependency_unavailable', 'Provider returned an invalid response.')
    let bytes = 0
    let body = ''
    const decoder = new TextDecoder()
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > 100_000) throw new ProviderConnectionError('dependency_unavailable', 'Provider response exceeded the connection-check limit.')
        body += decoder.decode(chunk.value, { stream: true })
      }
      body += decoder.decode()
      const result: unknown = JSON.parse(body)
      if (!result || typeof result !== 'object') throw new Error('Invalid response')
      const payload = result as Record<string, unknown>
      const valid = provider === 'opencode-go' ? !!payload.usage && typeof payload.usage === 'object'
        : provider === 'openrouter' ? !!payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
          : Array.isArray(payload.data) && payload.data.length > 0
      if (!valid || payload.error) throw new Error('Invalid response')
    } finally {
      await reader.cancel().catch(() => undefined)
    }
  }
  try {
    await Promise.race([request(), aborted])
  } catch (error) {
    if (controller.signal.aborted) {
      if (controller.signal.reason === 'timeout') throw new ProviderConnectionError('timeout', 'Provider connection timed out. Try again.')
      throw new DOMException('Provider connection cancelled.', 'AbortError')
    }
    if (error instanceof ProviderConnectionError) throw error
    throw new ProviderConnectionError('dependency_unavailable', 'Could not verify provider connectivity. Check your connection and try again.')
  } finally {
    clearTimeout(timeout)
    options.signal?.removeEventListener('abort', cancel)
    controller.signal.removeEventListener('abort', onAbort)
  }
}
