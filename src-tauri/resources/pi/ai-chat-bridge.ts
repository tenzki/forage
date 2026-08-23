import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { generateCodexSubscriptionImage } from './codex-image-generation'

const MAX_PAYLOAD_BYTES = 512_000
const MAX_TOOL_OUTPUT = 30_000
const MAX_CONTEXT_CHARACTERS = 40_000
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_IMAGE_RESPONSE_CHARS = 7_100_000
const IMAGE_MODEL = 'gpt-image-2'
const APPROVED_CUSTOM_ORIGINS = new Set(['https://api.github.com', 'https://api.open-meteo.com'])
const RESERVED_TOOLS = new Set(['emit_outline', 'web_search', 'web_fetch', 'generate_image', 'search_outline'])

interface CustomToolConfig {
  name: string
  description: string
  urlTemplate: string
}

interface OutlineNodeSnapshot {
  nodeId: string
  text: string
  depth: number
  ancestorTexts: string[]
}

interface RunPayload {
  instructions: string
  prompt: string
  context: string[]
  enabledToolIds: string[]
  customTools: CustomToolConfig[]
  /** Serialized outline snapshot for the search_outline tool. */
  outlineSnapshot?: string
}

interface StoredImage {
  src: string
  prompt: string
}

interface OutlineTextInput {
  text: string
  children?: OutlineInput[]
}

interface OutlineImageInput {
  imageId: string
  imageAlt?: string
}

type OutlineInput = OutlineTextInput | OutlineImageInput

type MaterializedOutline =
  | { text: string; children?: MaterializedOutline[] }
  | { type: 'image'; image: { src: string; alt: string } }

const imageId = Type.String({ pattern: '^img_[a-f0-9]{32}$' })
const imageAlt = Type.Optional(Type.String({ minLength: 1, maxLength: 500 }))
const OutlineImage = Type.Object({ imageId, imageAlt })
const OutlineTextLeaf = Type.Object({ text: Type.String({ minLength: 1, maxLength: 10_000 }) })
const OutlineLeaf = Type.Union([OutlineTextLeaf, OutlineImage])
const OutlineTextChild = Type.Object({
  text: Type.String({ minLength: 1, maxLength: 10_000 }),
  children: Type.Optional(Type.Array(OutlineLeaf, { maxItems: 100 })),
})
const OutlineChild = Type.Union([OutlineTextChild, OutlineImage])
const OutlineTextNode = Type.Object({
  text: Type.String({ minLength: 1, maxLength: 10_000 }),
  children: Type.Optional(Type.Array(OutlineChild, { maxItems: 100 })),
})
const OutlineNode = Type.Union([OutlineTextNode, OutlineImage])

function asStrings(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string').slice(0, limit)
}

function templateParameters(template: string): string[] {
  return [...template.matchAll(/\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g)]
    .map((match) => match[1])
    .filter((name, index, all) => all.indexOf(name) === index)
}

function validateCustomTool(value: unknown): CustomToolConfig | null {
  if (!value || typeof value !== 'object') return null
  const tool = value as Partial<CustomToolConfig>
  const name = typeof tool.name === 'string' ? tool.name.trim().toLowerCase() : ''
  const description = typeof tool.description === 'string' ? tool.description.trim() : ''
  const urlTemplate = typeof tool.urlTemplate === 'string' ? tool.urlTemplate.trim() : ''
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(name) || RESERVED_TOOLS.has(name)) return null
  if (!description || description.length > 500 || !templateParameters(urlTemplate).length) return null
  try {
    const sample = new URL(urlTemplate.replace(/\{\{[a-zA-Z][a-zA-Z0-9_]*\}\}/g, 'sample'))
    if (sample.protocol !== 'https:' || sample.username || sample.password) return null
    if (!APPROVED_CUSTOM_ORIGINS.has(sample.origin)) return null
  } catch {
    return null
  }
  return { name, description, urlTemplate }
}

function decodePayload(encoded: string): RunPayload {
  if (!encoded || encoded.length > MAX_PAYLOAD_BYTES) throw new Error('Invalid agent invocation payload.')
  const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<RunPayload>
  if (typeof value.instructions !== 'string' || typeof value.prompt !== 'string') {
    throw new Error('Agent invocation is missing instructions or a prompt.')
  }
  if (!Array.isArray(value.context) || value.context.some((item) => typeof item !== 'string')) {
    throw new Error('Agent invocation has invalid outline context.')
  }
  const contextCharacters = value.context.reduce((total, item) => total + item.length, 0)
  if (value.context.length > 500 || contextCharacters > MAX_CONTEXT_CHARACTERS) {
    throw new Error('Agent invocation outline context exceeds the safety limit.')
  }
  const customTools = Array.isArray(value.customTools)
    ? value.customTools.map(validateCustomTool).filter((tool): tool is CustomToolConfig => Boolean(tool)).slice(0, 25)
    : []
  const outlineSnapshot = typeof value.outlineSnapshot === 'string'
    ? value.outlineSnapshot.slice(0, MAX_PAYLOAD_BYTES) : ''
  return {
    instructions: value.instructions.slice(0, 20_000),
    prompt: value.prompt.slice(0, 20_000),
    context: value.context,
    enabledToolIds: asStrings(value.enabledToolIds, 50),
    customTools,
    outlineSnapshot,
  }
}

function taskMessage(payload: RunPayload): string {
  const context = payload.context.length
    ? `Selected outline context (hierarchy preserved by indentation):\n${payload.context.join('\n')}\n\n`
    : ''
  return `${context}Task: ${payload.prompt}`
}

function bounded(text: string, label: string): string {
  return text.length <= MAX_TOOL_OUTPUT ? text : `${text.slice(0, MAX_TOOL_OUTPUT)}\n\n[${label} output truncated]`
}

async function request(url: string, signal?: AbortSignal): Promise<Response> {
  const timeout = AbortSignal.timeout(20_000)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  return fetch(url, {
    signal: combined,
    redirect: 'error',
    headers: { 'User-Agent': 'AI Chat Pi bridge', Accept: 'text/plain, application/json, text/html' },
  })
}

function privateHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) return true
  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || parts.some(Number.isNaN)) return false
  const [first, second] = parts
  return first === 0 || first === 10 || first === 127 || first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) || (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168)
}

function publicUrl(value: string): URL {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || privateHostname(url.hostname)) {
    throw new Error('Only public HTTP and HTTPS URLs can be read.')
  }
  return url
}

function decodeHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim()
}

function duckResults(html: string, count: number): string {
  const blocks = html.match(/<div[^>]+class="[^"]*result[^"]*"[\s\S]*?<\/div>\s*<\/div>/g) ?? []
  const results: string[] = []
  for (const block of blocks) {
    const link = block.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/)
    if (!link) continue
    const target = new URL(link[1].replace(/&amp;/g, '&'), 'https://duckduckgo.com')
    const url = target.searchParams.get('uddg') ?? target.toString()
    const snippet = block.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\//)?.[1] ?? ''
    results.push(`${results.length + 1}. ${decodeHtml(link[2])}\n${url}\n${decodeHtml(snippet)}`)
    if (results.length >= count) break
  }
  return results.length ? results.join('\n\n') : 'No web results found.'
}

function registerWebTools(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'web_search',
    label: 'Web Search',
    description: 'Search the web for current information and source URLs.',
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 500 }),
      count: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
    }),
    async execute(_id, params, signal) {
      const count = Math.max(1, Math.min(10, params.count ?? 5))
      const response = await request(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(params.query)}`, signal)
      if (!response.ok) throw new Error(`Web search failed with HTTP ${response.status}.`)
      return { content: [{ type: 'text', text: bounded(duckResults(await response.text(), count), 'Web search') }] }
    },
  })
  pi.registerTool({
    name: 'web_fetch',
    label: 'Read Webpage',
    description: 'Read a public webpage as clean Markdown through Jina Reader.',
    parameters: Type.Object({ url: Type.String({ minLength: 1, maxLength: 4_000 }) }),
    async execute(_id, params, signal) {
      const target = publicUrl(params.url)
      const response = await request(`https://r.jina.ai/${target.toString()}`, signal)
      if (!response.ok) throw new Error(`Webpage reader failed with HTTP ${response.status}.`)
      return { content: [{ type: 'text', text: bounded(await response.text(), 'Webpage') }] }
    },
  })
}

function apiImageCredential(): string {
  const key = process.env.AI_CHAT_API_KEY?.trim()
  if (key) return key
  throw new Error('Image generation requires an OpenAI API key. Add one in Settings.')
}

function subscriptionImageCredential(): { accessToken: string; accountId: string } {
  const accessToken = process.env.AI_CHAT_API_KEY?.trim()
  const accountId = process.env.AI_CHAT_ACCOUNT_ID?.trim()
  if (!accessToken || !accountId) {
    throw new Error('ChatGPT subscription credentials are missing. Reconnect ChatGPT in Settings.')
  }
  return { accessToken, accountId }
}

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

async function generateApiImage(prompt: string, size: string, quality: string, signal?: AbortSignal): Promise<StoredImage> {
  const timeout = AbortSignal.timeout(120_000)
  const response = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    redirect: 'error',
    headers: {
      Authorization: `Bearer ${apiImageCredential()}`,
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
  return { src: `data:image/webp;base64,${base64}`, prompt }
}

async function generateImage(prompt: string, size: string, quality: string, signal?: AbortSignal): Promise<StoredImage> {
  if (process.env.AI_CHAT_PROVIDER !== 'openai-codex') {
    return generateApiImage(prompt, size, quality, signal)
  }
  const credential = subscriptionImageCredential()
  const image = await generateCodexSubscriptionImage({ prompt, size, quality, ...credential, signal })
  return { src: `data:image/png;base64,${image.base64}`, prompt }
}

function registerImageTool(pi: ExtensionAPI, images: Map<string, StoredImage>) {
  pi.registerTool({
    name: 'generate_image',
    label: 'Generate Image',
    description: `Generate one image with OpenAI ${IMAGE_MODEL}. Returns an imageId to attach to an emit_outline node. Subscription mode uses included Codex limits; API-key mode uses API billing.`,
    parameters: Type.Object({
      prompt: Type.String({ minLength: 1, maxLength: 4_000 }),
      size: Type.Optional(Type.Union([Type.Literal('1024x1024'), Type.Literal('1536x1024'), Type.Literal('1024x1536')])),
      quality: Type.Optional(Type.Union([Type.Literal('low'), Type.Literal('medium')])),
    }),
    async execute(_id, params, signal) {
      if (images.size >= 1) throw new Error('At most one image can be generated in one run.')
      const prompt = params.prompt.trim()
      const image = await generateImage(prompt, params.size ?? '1024x1024', params.quality ?? 'low', signal)
      const imageId = `img_${crypto.randomUUID().replace(/-/g, '')}`
      images.set(imageId, image)
      return {
        content: [{ type: 'text', text: `Generated image ${imageId}. Attach this exact imageId to an emit_outline node.` }],
        details: { action: 'generated_image', imageId },
      }
    },
  })
}

function materializeOutline(nodes: OutlineInput[], images: Map<string, StoredImage>): MaterializedOutline[] {
  return nodes.map((node) => {
    if ('imageId' in node) {
      const stored = images.get(node.imageId)
      if (!stored) throw new Error('emit_outline referenced an unknown generated image.')
      return {
        type: 'image',
        image: { src: stored.src, alt: node.imageAlt?.trim() || stored.prompt.slice(0, 500) },
      }
    }
    const children = node.children?.length ? materializeOutline(node.children, images) : undefined
    return { text: node.text, ...(children ? { children } : {}) }
  })
}

function registerCustomTool(pi: ExtensionAPI, config: CustomToolConfig) {
  const parameters = templateParameters(config.urlTemplate)
  const properties = Object.fromEntries(parameters.map((name) => [name, Type.String({ minLength: 1, maxLength: 1_000 })]))
  pi.registerTool({
    name: config.name,
    label: config.name,
    description: config.description,
    parameters: Type.Object(properties),
    async execute(_id, params, signal) {
      const value = params as Record<string, unknown>
      const rendered = config.urlTemplate.replace(/\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g, (_match, name) => {
        const argument = value[name]
        if (typeof argument !== 'string' || !argument.trim()) throw new Error(`${config.name} requires ${name}.`)
        return encodeURIComponent(argument.trim())
      })
      const url = new URL(rendered)
      if (!APPROVED_CUSTOM_ORIGINS.has(url.origin)) throw new Error('Custom tool origin is not approved.')
      const response = await request(url.toString(), signal)
      if (!response.ok) throw new Error(`${config.name} failed with HTTP ${response.status}.`)
      return { content: [{ type: 'text', text: bounded(await response.text(), config.name) }] }
    },
  })
}

function registerSearchTool(pi: ExtensionAPI, snapshot: () => OutlineNodeSnapshot[]) {
  pi.registerTool({
    name: 'search_outline',
    label: 'Search Outline',
    description: 'Search the current outline for existing nodes whose text matches the query. Returns matching nodes with their path for context. Call this when you need to check whether the user already has notes, decisions, or research on a topic before writing new content.',
    promptSnippet: 'Search existing notes using search_outline before writing duplicate content',
    promptGuidelines: [
      'Use search_outline before writing about a topic to check if the user already has notes about it.',
      'When search_outline returns existing nodes, reference or expand them rather than duplicating.',
    ],
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 500, description: 'Text to search for in existing outline nodes' }),
      maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: 'Maximum matching results (default 10)' })),
    }),
    async execute(_id, params, _signal) {
      const nodes = snapshot()
      const query = params.query.trim()
      if (!query || !nodes.length) {
        return { content: [{ type: 'text', text: 'The outline has no searchable nodes.' }] }
      }
      const maxResults = Math.max(1, Math.min(20, Math.floor(params.maxResults ?? 10)))
      const lower = query.toLowerCase()
      const withScore: Array<{
        text: string; depth: number; path: string; field: 'text' | 'ancestor'; score: number
      }> = []
      for (const node of nodes) {
        const textLower = node.text.toLowerCase()
        if (textLower.includes(lower)) {
          const path = [...node.ancestorTexts].reverse().concat(node.text).join(' / ')
          withScore.push({ text: node.text, depth: node.depth, path, field: 'text', score: node.depth })
          continue
        }
        const ancIdx = node.ancestorTexts.findIndex((a) => a.toLowerCase().includes(lower))
        if (ancIdx !== -1) {
          const path = [...node.ancestorTexts].reverse().concat(node.text).join(' / ')
          withScore.push({ text: node.text, depth: node.depth, path, field: 'ancestor', score: 1000 + node.depth })
        }
      }
      withScore.sort((a, b) => a.score - b.score)
      const results = withScore.slice(0, maxResults)
      if (!results.length) {
        return { content: [{ type: 'text', text: `No existing outline nodes match "${query}".` }] }
      }
      const header = `Found ${results.length} matching node(s) for "${query}" in the outline:\n\n`
      const body = results.map((r, i) => {
        const tag = r.field === 'ancestor' ? ' (ancestor match)' : ''
        return `${i + 1}. ${r.text}${tag}\n   Path: ${r.path}`
      }).join('\n\n')
      return { content: [{ type: 'text', text: bounded(header + body, 'Search results') }] }
    },
  })
}

export default function aiChatBridge(pi: ExtensionAPI) {
  const providerId = process.env.AI_CHAT_PROVIDER
  if ((providerId === 'openai' || providerId === 'openai-codex') && process.env.AI_CHAT_API_KEY) {
    pi.registerProvider(providerId, { apiKey: '$AI_CHAT_API_KEY' })
  }

  let activeInstructions: string | null = null
  const generatedImages = new Map<string, StoredImage>()
  let outlineSnapshot: OutlineNodeSnapshot[] = []

  registerWebTools(pi)
  registerImageTool(pi, generatedImages)

  pi.registerTool({
    name: 'emit_outline',
    label: 'Emit Outline',
    description: 'Return the final answer as structured text or image outline nodes. A generated image must be a separate image-only node using the imageId returned by generate_image.',
    promptSnippet: 'Emit the final response as nested text nodes and separate generated-image nodes',
    promptGuidelines: ['Use emit_outline as the final action for every task.', 'Emit each generated image as its own image-only node with imageId and imageAlt; never attach it to a text node.'],
    parameters: Type.Object({ nodes: Type.Array(OutlineNode, { minItems: 1, maxItems: 100 }) }),
    async execute(_toolCallId, params) {
      return {
        content: [{ type: 'text', text: `Created ${params.nodes.length} outline node(s).` }],
        details: { action: 'emit_outline', nodes: materializeOutline(params.nodes as OutlineInput[], generatedImages) },
        terminate: true,
      }
    },
  })

  registerSearchTool(pi, () => outlineSnapshot)

  pi.registerCommand('ai-chat-run', {
    description: 'Run an AI Chat agent profile',
    handler: async (args, ctx) => {
      try {
        const payload = decodePayload(args.trim())
        generatedImages.clear()
        outlineSnapshot = []
        if (payload.outlineSnapshot) {
          try {
            const parsed = JSON.parse(payload.outlineSnapshot) as unknown
            if (Array.isArray(parsed)) outlineSnapshot = parsed as OutlineNodeSnapshot[]
          } catch { /* ignore malformed snapshot */ }
        }
        for (const tool of payload.customTools) registerCustomTool(pi, tool)
        const activeTools = [
          'emit_outline',
          'search_outline',
          ...payload.enabledToolIds.filter((id) => id === 'web_search' || id === 'web_fetch' || id === 'generate_image'),
          ...payload.customTools.map((tool) => tool.name),
        ]
        pi.setActiveTools([...new Set(activeTools)])
        activeInstructions = payload.instructions
        pi.sendUserMessage(taskMessage(payload))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.ui.notify(message, 'error')
        throw error
      }
    },
  })

  pi.on('before_agent_start', (event) => activeInstructions ? {
    systemPrompt: [
      event.systemPrompt,
      activeInstructions,
      'Return the final answer by calling emit_outline. Do not edit files or run shell commands.',
    ].join('\n\n'),
  } : undefined)

  pi.on('agent_settled', () => { activeInstructions = null })
}