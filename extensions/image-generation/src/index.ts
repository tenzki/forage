import { defineExtension, type ExtensionToolExecutionContext } from '@forage/extension-api'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { generateApiImage } from './api-image-generation.js'
import { generateCodexSubscriptionImage } from './codex-image-generation.js'

export const imageTool = {
  id: 'generate_image',
  name: 'Generate images',
  description: 'Generate one image using OpenAI GPT Image 2. Returns an imageId for a separate image-only emit_outline node.',
}

interface ImageInput { prompt: string; size: string; quality: string }

function parseInput(input: unknown): ImageInput {
  if (!input || typeof input !== 'object') throw new Error('An image prompt is required.')
  const value = input as Record<string, unknown>
  if (typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > 4_000) {
    throw new Error('Image prompt must contain 1–4,000 characters.')
  }
  const size = value.size ?? '1024x1024'
  const quality = value.quality ?? 'low'
  if (!['1024x1024', '1536x1024', '1024x1536'].includes(size as string)) throw new Error('Unsupported image size.')
  if (!['low', 'medium'].includes(quality as string)) throw new Error('Unsupported image quality.')
  return { prompt: value.prompt.trim(), size: size as string, quality: quality as string }
}

/** Read only the login cache, never the user's Codex configuration or extensions. */
export async function codexCredential(): Promise<{ accessToken: string; accountId: string }> {
  try {
    const raw = JSON.parse(await readFile(join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json'), 'utf8'))
    const accessToken = raw?.tokens?.access_token
    const accountId = raw?.tokens?.account_id
    if (typeof accessToken === 'string' && accessToken.trim() && typeof accountId === 'string' && accountId.trim()) {
      return { accessToken, accountId }
    }
  } catch { /* Never expose credential file contents or parser diagnostics. */ }
  throw new Error('A file-based Codex ChatGPT login is required. Run codex -c cli_auth_credentials_store=\'"file"\' login, then retry.')
}

async function generate(input: ImageInput, context: ExtensionToolExecutionContext) {
  const { prompt, size, quality } = input
  context.signal.throwIfAborted()
  if (context.settings.provider === 'api') {
    const key = context.secrets.api_key?.trim()
    if (!key) throw new Error('Add an OpenAI API key in the Image Generation extension settings.')
    const base64 = await generateApiImage(prompt, size, quality, key, context.signal)
    return { image: { mediaType: 'image/webp' as const, base64, alt: prompt.slice(0, 500) } }
  }
  if (context.settings.provider !== 'codex') throw new Error('Select an image provider in extension settings.')
  const credential = await codexCredential()
  try {
    const image = await generateCodexSubscriptionImage({ ...input, ...credential, signal: context.signal })
    return { image: { mediaType: 'image/png' as const, base64: image.base64, alt: prompt.slice(0, 500) } }
  } catch (error) {
    // These credentials are read by this extension, so the host cannot redact them.
    const message = error instanceof Error ? error.message : 'Codex image generation failed.'
    throw new Error(message.split(credential.accessToken).join('[redacted]').split(credential.accountId).join('[redacted]'))
  }
}

export default defineExtension((host) => {
  let used = false
  host.on('run:start', () => { used = false })
  host.registerTool({
    ...imageTool,
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', minLength: 1, maxLength: 4_000 },
        size: { type: 'string', enum: ['1024x1024', '1536x1024', '1024x1536'] },
        quality: { type: 'string', enum: ['low', 'medium'] },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    async execute(raw, context) {
      const input = parseInput(raw)
      if (used) throw new Error('At most one image can be generated in one run.')
      used = true
      try {
        context.reportProgress({ message: 'Generating image…' })
        return await generate(input, context)
      } catch (error) {
        used = false
        const message = error instanceof Error ? error.message : 'Image generation failed.'
        const redacted = Object.values(context.secrets).reduce<string>(
          (text, secret) => secret ? text.split(secret).join('[redacted]') : text, message,
        )
        throw new Error(redacted)
      }
    },
  })
})
