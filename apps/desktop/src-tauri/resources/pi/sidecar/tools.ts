import { Type } from '@earendil-works/pi-ai'
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent'
import { fetch as undiciFetch } from 'undici'

// ── bounds ──────────────────────────────────────────────────────────────────

const MAX_TOOL_OUTPUT = 30_000
const APPROVED_CUSTOM_ORIGINS = new Set(['https://api.github.com', 'https://api.open-meteo.com'])
const RESERVED_TOOLS = new Set(['emit_outline', 'web_search', 'web_fetch', 'search_outline'])

// ── types ───────────────────────────────────────────────────────────────────

export interface CustomToolConfig {
  name: string
  description: string
  urlTemplate: string
}

export interface OutlineSnapshotNode {
  nodeId: string
  text: string
  depth: number
  ancestorTexts: string[]
}

// ── helpers ─────────────────────────────────────────────────────────────────

function bounded(text: string, label: string): string {
  return text.length <= MAX_TOOL_OUTPUT ? text : `${text.slice(0, MAX_TOOL_OUTPUT)}\n\n[${label} output truncated]`
}

function templateParameters(template: string): string[] {
  return [...template.matchAll(/\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g)]
    .map((m) => m[1])
    .filter((name, i, all) => all.indexOf(name) === i)
}

function privateHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) return true
  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || parts.some(Number.isNaN)) return false
  const [first, second] = parts
  return first === 0 || first === 10 || first === 127 || first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
}

function publicUrl(value: string): URL {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || privateHostname(url.hostname)) {
    throw new Error('Only public HTTP and HTTPS URLs can be read.')
  }
  return url
}

async function request(url: string, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(20_000)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
  return undiciFetch(url, {
    signal: combined,
    redirect: 'error',
    headers: { 'User-Agent': 'Forage Pi sidecar', Accept: 'text/plain, application/json, text/html' },
  })
}

// ── DuckDuckGo HTML scraping ────────────────────────────────────────────────

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

// ── tool factories ──────────────────────────────────────────────────────────

export function createWebSearchTool(): ToolDefinition {
  return defineTool({
    name: 'web_search',
    label: 'Web Search',
    description: 'Search the web for current information and source URLs.',
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 500 }),
      count: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
    }),
    async execute(_toolCallId, params, signal) {
      const count = Math.max(1, Math.min(10, params.count ?? 5))
      const response = await request(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(params.query)}`, signal)
      if (!response.ok) throw new Error(`Web search failed with HTTP ${response.status}.`)
      return { content: [{ type: 'text', text: bounded(duckResults(await response.text(), count), 'Web search') }], details: {} }
    },
  })
}

/** Pages read successfully are registered, so the result may cite them. */
export function createWebFetchTool(sources?: { register(url: string): void }): ToolDefinition {
  return defineTool({
    name: 'web_fetch',
    label: 'Read Webpage',
    description: 'Read a public webpage as clean Markdown through Jina Reader.',
    parameters: Type.Object({ url: Type.String({ minLength: 1, maxLength: 4_000 }) }),
    async execute(_toolCallId, params, signal) {
      const target = publicUrl(params.url)
      const response = await request(`https://r.jina.ai/${target.toString()}`, signal)
      if (!response.ok) throw new Error(`Webpage reader failed with HTTP ${response.status}.`)
      const text = bounded(await response.text(), 'Webpage')
      sources?.register(target.toString())
      return { content: [{ type: 'text', text }], details: {} }
    },
  })
}

export function createSearchOutlineTool(snapshot: () => OutlineSnapshotNode[]): ToolDefinition {
  return defineTool({
    name: 'search_outline',
    label: 'Search Outline',
    description: 'Search the current outline for existing nodes whose text matches the query. Returns matching nodes with their path for context.',
    promptSnippet: 'Search existing notes using search_outline before writing duplicate content',
    promptGuidelines: [
      'Use search_outline before writing about a topic to check if the user already has notes about it.',
      'When search_outline returns existing nodes, reference or expand them rather than duplicating.',
    ],
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 500 }),
      maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
    }),
    async execute(_toolCallId, params) {
      const nodes = snapshot()
      const query = params.query.trim()
      if (!query || !nodes.length) {
        return { content: [{ type: 'text', text: 'The outline has no searchable nodes.' }], details: {} }
      }
      const maxResults = Math.max(1, Math.min(20, Math.floor(params.maxResults ?? 10)))
      const lower = query.toLowerCase()
      const withScore: Array<{ text: string; depth: number; path: string; field: 'text' | 'ancestor'; score: number }> = []
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
        return { content: [{ type: 'text', text: `No existing outline nodes match "${query}".` }], details: {} }
      }
      const header = `Found ${results.length} matching node(s) for "${query}" in the outline:\n\n`
      const body = results.map((r, i) => {
        const tag = r.field === 'ancestor' ? ' (ancestor match)' : ''
        return `${i + 1}. ${r.text}${tag}\n   Path: ${r.path}`
      }).join('\n\n')
      return { content: [{ type: 'text', text: bounded(header + body, 'Search results') }], details: {} }
    },
  })
}

export function createCustomHttpTool(config: CustomToolConfig): ToolDefinition {
  const parameters = templateParameters(config.urlTemplate)
  const properties = Object.fromEntries(parameters.map((name) => [name, Type.String({ minLength: 1, maxLength: 1_000 })]))
  return defineTool({
    name: config.name,
    label: config.name,
    description: config.description,
    parameters: Type.Object(properties),
    async execute(_toolCallId, params, signal) {
      const rendered = config.urlTemplate.replace(/\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g, (_match, name) => {
        const argument = (params as Record<string, string>)[name]
        if (typeof argument !== 'string' || !argument.trim()) throw new Error(`${config.name} requires ${name}.`)
        return encodeURIComponent(argument.trim())
      })
      const url = new URL(rendered)
      if (!APPROVED_CUSTOM_ORIGINS.has(url.origin)) throw new Error('Custom tool origin is not approved.')
      const response = await request(url.toString(), signal)
      if (!response.ok) throw new Error(`${config.name} failed with HTTP ${response.status}.`)
      return { content: [{ type: 'text', text: bounded(await response.text(), config.name) }], details: {} }
    },
  })
}

// ── validation ──────────────────────────────────────────────────────────────

export function validateCustomTool(value: unknown): CustomToolConfig | null {
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
