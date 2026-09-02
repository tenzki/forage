import { verifyAssetBytes, type AssetStorage } from './assets.js'
import type { ResolvedModelCredential } from './credentialService.js'
import type { Principal, ServerRepository } from './repository.js'
import { ProviderError } from './transcript.js'

const MAX_IMAGE_RESPONSE_CHARACTERS = 7_100_000

interface ImageGeneratorOptions {
  repository: ServerRepository
  storage: AssetStorage
  principal: Principal
  credential: ResolvedModelCredential
  fetch?: typeof globalThis.fetch
  endpoint?: string
}

export interface GeneratedImageAsset {
  assetId: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp'
  byteSize: number
  alt: string
}

export class OpenAIImageAssetGenerator {
  private readonly fetch: typeof globalThis.fetch
  constructor(private readonly options: ImageGeneratorOptions) { this.fetch = options.fetch ?? globalThis.fetch }

  async generate(prompt: string, signal: AbortSignal): Promise<GeneratedImageAsset> {
    if (this.options.credential.provider !== 'openai') {
      throw new ProviderError('unsupported_tool', 'Server image generation requires an enrolled OpenAI API key.', false)
    }
    const response = await this.fetch(this.options.endpoint ?? 'https://api.openai.com/v1/images/generations', {
      method: 'POST', signal, redirect: 'error',
      headers: {
        authorization: `Bearer ${this.options.credential.apiKey}`,
        'content-type': 'application/json', accept: 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-image-2', prompt, n: 1, size: '1024x1024', quality: 'medium',
        output_format: 'webp', output_compression: 80,
      }),
    })
    const declared = Number(response.headers.get('content-length') ?? 0)
    if (declared > MAX_IMAGE_RESPONSE_CHARACTERS) throw invalidImageResponse('Image provider response is too large.')
    const serialized = await response.text()
    if (serialized.length > MAX_IMAGE_RESPONSE_CHARACTERS) throw invalidImageResponse('Image provider response is too large.')
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new ProviderError('authentication_required', 'Image provider authentication is required.', false)
      if (response.status === 429) throw new ProviderError('provider_rate_limited', 'Image provider rate limited the request.', true)
      throw new ProviderError('dependency_unavailable', 'Image provider is temporarily unavailable.', response.status >= 500)
    }
    let base64: unknown
    try { base64 = (JSON.parse(serialized) as { data?: Array<{ b64_json?: unknown }> }).data?.[0]?.b64_json } catch { throw invalidImageResponse() }
    if (typeof base64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 !== 0) throw invalidImageResponse()
    const bytes = Buffer.from(base64, 'base64')
    if (bytes.toString('base64') !== base64) throw invalidImageResponse()
    let verified
    try { verified = await verifyAssetBytes(bytes, 'image/webp') } catch { throw invalidImageResponse() }
    const initiated = await this.options.repository.initiateAsset(this.options.principal, verified)
    if (!initiated.completed) {
      const stored = await this.options.storage.putVerified(verified.assetId, bytes)
      await this.options.repository.completeAsset(this.options.principal, verified.assetId, stored.storageKey)
    }
    return { ...verified, alt: prompt.trim().slice(0, 500) || 'Generated image' }
  }
}

function invalidImageResponse(message = 'Image provider returned invalid data.'): ProviderError {
  return new ProviderError('invalid_output', message, false)
}
