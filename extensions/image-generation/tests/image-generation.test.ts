import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtensionToolDefinition, ExtensionToolExecutionContext, ForageExtensionHost } from '@forage/extension-api'
import { extensionToolResultSchema } from '@forage/agent-runtime'

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), readFile: vi.fn(), codex: vi.fn() }))
vi.mock('undici', () => ({ fetch: mocks.fetch }))
vi.mock('node:fs/promises', () => ({ readFile: mocks.readFile }))
vi.mock('../src/codex-image-generation.js', () => ({ generateCodexSubscriptionImage: mocks.codex }))
import setup, { codexCredential } from '../src/index'

const WEBP = Buffer.from('RIFF0000WEBPimage').toString('base64')
let tool: ExtensionToolDefinition
let start: () => void
const context = (): ExtensionToolExecutionContext => ({
  signal: new AbortController().signal, settings: { provider: 'api' },
  secrets: { api_key: 'extension-key' }, log: vi.fn(), reportProgress: vi.fn(),
})

beforeEach(async () => {
  vi.resetAllMocks()
  await setup({
    registerTool(value) { tool = value },
    on(_event, callback) { start = callback as () => void },
  } as ForageExtensionHost)
  mocks.fetch.mockImplementation(async () => new Response(JSON.stringify({ data: [{ b64_json: WEBP }] })))
})
afterEach(() => vi.unstubAllEnvs())

describe('image generation extension', () => {
  it('uses only its scoped API key and returns a host image result', async () => {
    vi.stubEnv('AI_CHAT_API_KEY', 'model-key')
    vi.stubEnv('AI_CHAT_PROVIDER', 'openai-codex')
    const result = await tool.execute({ prompt: ' An otter ' }, context())
    expect(result).toEqual({ image: { mediaType: 'image/webp', base64: WEBP, alt: 'An otter' } })
    expect(extensionToolResultSchema.parse(result)).toEqual(result)
    const [, options] = mocks.fetch.mock.calls[0]
    expect(options.headers.Authorization).toBe('Bearer extension-key')
    expect(JSON.parse(options.body)).toMatchObject({ model: 'gpt-image-2', size: '1024x1024', quality: 'low' })
    expect(mocks.codex).not.toHaveBeenCalled()
  })

  it('requires a configured extension key without falling back to model credentials', async () => {
    vi.stubEnv('AI_CHAT_API_KEY', 'model-key')
    await expect(tool.execute({ prompt: 'Otter' }, { ...context(), secrets: {} })).rejects.toThrow('extension settings')
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('redacts the scoped API key from provider failures', async () => {
    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'invalid extension-key' } }), { status: 401 }))
    await expect(tool.execute({ prompt: 'Otter' }, context())).rejects.toThrow('invalid [redacted]')
  })

  it('allows one generation per run, including concurrent requests, and resets on run start', async () => {
    const first = tool.execute({ prompt: 'Otter' }, context())
    await expect(tool.execute({ prompt: 'Second' }, context())).rejects.toThrow('At most one')
    await first
    await expect(tool.execute({ prompt: 'Second' }, context())).rejects.toThrow('At most one')
    start()
    await expect(tool.execute({ prompt: 'New run' }, context())).resolves.toHaveProperty('image')
  })

  it('allows retries after failure and validates provider output', async () => {
    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ b64_json: 'bm90LWltYWdl' }] })))
    await expect(tool.execute({ prompt: 'Otter' }, context())).rejects.toThrow('invalid or oversized')
    await expect(tool.execute({ prompt: 'Otter' }, context())).resolves.toHaveProperty('image')
  })

  it('rejects invalid prompts and cancellation before contacting a provider', async () => {
    await expect(tool.execute({ prompt: ' ' }, context())).rejects.toThrow('prompt')
    const controller = new AbortController()
    controller.abort()
    await expect(tool.execute({ prompt: 'Otter' }, { ...context(), signal: controller.signal })).rejects.toThrow()
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('uses the local Codex login for subscription images and redacts its errors', async () => {
    mocks.readFile.mockResolvedValue(JSON.stringify({ tokens: { access_token: 'local-token', account_id: 'local-account' } }))
    mocks.codex.mockRejectedValue(new Error('failed local-token local-account'))
    await expect(tool.execute({ prompt: 'Otter' }, { ...context(), settings: { provider: 'codex' } }))
      .rejects.toThrow('failed [redacted] [redacted]')
    expect(mocks.codex).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'local-token', accountId: 'local-account' }))
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('reports missing or malformed local logins without leaking file contents', async () => {
    mocks.readFile.mockResolvedValue('secret invalid json')
    await expect(codexCredential()).rejects.toThrow('file-based Codex ChatGPT login')
  })
})
