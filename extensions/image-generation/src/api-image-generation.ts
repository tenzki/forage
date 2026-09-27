import { fetch as undiciFetch } from 'undici'

const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_IMAGE_RESPONSE_CHARS = 7_100_000
const IMAGE_MODEL = 'gpt-image-2'

function validWebp(base64: string): boolean {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 !== 0) return false
  const bytes = Buffer.from(base64, 'base64')
  return bytes.length > 0 && bytes.length <= MAX_IMAGE_BYTES
    && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP'
}

function apiError(text: string, status: number): Error {
  try {
    const parsed = JSON.parse(text) as { error?: { code?: unknown; message?: unknown } }
    const code = typeof parsed.error?.code === 'string' ? ` (${parsed.error.code})` : ''
    const detail = typeof parsed.error?.message === 'string' ? ` ${parsed.error.message.slice(0, 500)}` : ''
    return new Error(`OpenAI image generation failed with HTTP ${status}${code}.${detail}`)
  } catch {
    return new Error(`OpenAI image generation failed with HTTP ${status}.`)
  }
}

export async function generateApiImage(prompt: string, size: string, quality: string, apiKey: string, signal?: AbortSignal): Promise<string> {
  const timeout = AbortSignal.timeout(120_000)
  const response = await undiciFetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    redirect: 'error',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      model: IMAGE_MODEL,
      prompt,
      n: 1,
      size,
      quality,
      output_format: 'webp',
      output_compression: 80,
    }),
  })
  const declared = Number(response.headers.get('content-length') ?? 0)
  if (declared > MAX_IMAGE_RESPONSE_CHARS) throw new Error('OpenAI image response exceeded the allowed size.')
  const text = await response.text()
  if (text.length > MAX_IMAGE_RESPONSE_CHARS) throw new Error('OpenAI image response exceeded the allowed size.')
  if (!response.ok) throw apiError(text, response.status)
  const parsed = JSON.parse(text) as { data?: Array<{ b64_json?: unknown }> }
  const base64 = parsed.data?.[0]?.b64_json
  if (typeof base64 !== 'string' || !validWebp(base64)) throw new Error('OpenAI returned an invalid or oversized image.')
  return base64
}

