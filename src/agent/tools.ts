import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { Type, type Tool } from '@earendil-works/pi-ai'

const MAX_RESULTS = 10
const MAX_OUTPUT_CHARS = 30_000
const TOOL_TIMEOUT_MS = 20_000

export const WEB_SEARCH_TOOL_ID = 'web_search'
export const WEB_FETCH_TOOL_ID = 'web_fetch'
export const IMAGE_GENERATION_TOOL_ID = 'generate_image'
export const SEARCH_OUTLINE_TOOL_ID = 'search_outline'

export interface ExecutableTool {
  definition: Tool
  activity: (arguments_: Record<string, unknown>) => string
  execute: (arguments_: Record<string, unknown>, signal?: AbortSignal) => Promise<string>
}

interface SearchResult {
  title: string
  url: string
  snippet: string
}

export interface ToolOption {
  id: string
  name: string
  description: string
}

export interface CustomHttpToolConfig {
  id: string
  name: string
  description: string
  urlTemplate: string
}

export interface CustomHttpToolDraft {
  name: string
  description: string
  urlTemplate: string
}

export const APPROVED_TOOL_ORIGINS = [
  {
    origin: 'https://api.github.com',
    label: 'GitHub public API',
    examplePath: '/repos/{{owner}}/{{repo}}/issues',
  },
  {
    origin: 'https://api.open-meteo.com',
    label: 'Open-Meteo',
    examplePath: '/v1/forecast?latitude={{latitude}}&longitude={{longitude}}&current=temperature_2m',
  },
] as const

export const BUILTIN_TOOL_OPTIONS: ToolOption[] = [
  {
    id: WEB_SEARCH_TOOL_ID,
    name: 'Web search',
    description: 'Search DuckDuckGo for current information and sources.',
  },
  {
    id: WEB_FETCH_TOOL_ID,
    name: 'Read webpages',
    description: 'Extract readable Markdown from a public webpage through Jina Reader.',
  },
  {
    id: IMAGE_GENERATION_TOOL_ID,
    name: 'Generate images',
    description: 'Generate a bounded image with OpenAI GPT Image 2 through Codex subscription limits or API billing.',
  },
  {
    id: SEARCH_OUTLINE_TOOL_ID,
    name: 'Search existing notes',
    description: 'Search outline nodes the user already has to check for existing content on a topic.',
  },
]

function truncateOutput(output: string, label: string): string {
  return output.length <= MAX_OUTPUT_CHARS
    ? output
    : `${output.slice(0, MAX_OUTPUT_CHARS)}\n\n[${label} output truncated]`
}

function textContent(element: Element | null): string {
  return element?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
}

function resultUrl(href: string): string {
  const url = new URL(href, 'https://duckduckgo.com')
  return url.searchParams.get('uddg') ?? url.toString()
}

export function parseDuckDuckGoResults(html: string, limit: number): SearchResult[] {
  const document = new DOMParser().parseFromString(html, 'text/html')
  const results: SearchResult[] = []
  for (const block of document.querySelectorAll('.result')) {
    const link = block.querySelector<HTMLAnchorElement>('a.result__a')
    if (!link?.getAttribute('href')) continue
    results.push({
      title: textContent(link),
      url: resultUrl(link.getAttribute('href')!),
      snippet: textContent(block.querySelector('.result__snippet')),
    })
    if (results.length >= limit) break
  }
  return results
}

function searchArguments(arguments_: Record<string, unknown>): { query: string; count: number } {
  const query = typeof arguments_.query === 'string' ? arguments_.query.trim() : ''
  if (!query) throw new Error('web_search requires a non-empty query.')
  const requested = typeof arguments_.count === 'number' ? arguments_.count : 5
  return { query, count: Math.max(1, Math.min(MAX_RESULTS, Math.floor(requested))) }
}

async function fetchWithTimeout(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  const controller = new AbortController()
  const abort = () => controller.abort(signal?.reason)
  signal?.addEventListener('abort', abort, { once: true })
  const timer = window.setTimeout(() => controller.abort('Tool request timed out.'), TOOL_TIMEOUT_MS)
  try {
    return await tauriFetch(url, { ...init, signal: controller.signal })
  } finally {
    window.clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}

async function webSearch(arguments_: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  const { query, count } = searchArguments(arguments_)
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const response = await fetchWithTimeout(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Forage web search)' },
  }, signal)
  if (!response.ok) throw new Error(`Web search failed with HTTP ${response.status}.`)
  const results = parseDuckDuckGoResults(await response.text(), count)
  if (!results.length) return `No web results found for: ${query}`
  const output = results
    .map((result, index) => `${index + 1}. ${result.title}\n${result.url}\n${result.snippet}`)
    .join('\n\n')
  return truncateOutput(output, 'Web search')
}

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  if (host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) return true
  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || parts.some(Number.isNaN)) return false
  const [first, second] = parts
  return first === 0 || first === 10 || first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) || first >= 224
}

export function validatePublicWebUrl(value: unknown): URL {
  if (typeof value !== 'string' || !value.trim()) throw new Error('web_fetch requires a URL.')
  const url = new URL(value.trim())
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS webpages can be read.')
  if (url.username || url.password) throw new Error('Webpage URLs cannot contain credentials.')
  if (isPrivateHostname(url.hostname)) throw new Error('Private and local network URLs cannot be read.')
  return url
}

async function webFetch(arguments_: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  const target = validatePublicWebUrl(arguments_.url)
  const readerUrl = `https://r.jina.ai/${target.toString()}`
  const response = await fetchWithTimeout(readerUrl, {
    headers: { Accept: 'text/plain' },
  }, signal)
  if (!response.ok) throw new Error(`Webpage reader failed with HTTP ${response.status}.`)
  const content = (await response.text()).trim()
  return content ? truncateOutput(content, 'Webpage') : `No readable content found at ${target}`
}

function templateParameters(template: string): string[] {
  return [...template.matchAll(/\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g)]
    .map((match) => match[1])
    .filter((name, index, all) => all.indexOf(name) === index)
}

function approvedTemplateUrl(template: string): URL {
  const substituted = template.replace(/\{\{[a-zA-Z][a-zA-Z0-9_]*\}\}/g, 'example')
  const url = new URL(substituted)
  if (!APPROVED_TOOL_ORIGINS.some((item) => item.origin === url.origin)) {
    throw new Error('Choose an approved API origin.')
  }
  if (url.protocol !== 'https:') throw new Error('Custom tools must use HTTPS.')
  if (url.username || url.password) throw new Error('Custom tool URLs cannot contain credentials.')
  return url
}

export function validateCustomToolDraft(draft: CustomHttpToolDraft): CustomHttpToolDraft {
  const name = draft.name.trim().toLowerCase()
  const description = draft.description.trim()
  const urlTemplate = draft.urlTemplate.trim()
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(name)) {
    throw new Error('Tool names must use 2–64 lowercase letters, numbers, or underscores.')
  }
  if ([WEB_SEARCH_TOOL_ID, WEB_FETCH_TOOL_ID, IMAGE_GENERATION_TOOL_ID, SEARCH_OUTLINE_TOOL_ID].includes(name)) throw new Error('That tool name is reserved.')
  if (!description || description.length > 500) throw new Error('Add a description of up to 500 characters.')
  approvedTemplateUrl(urlTemplate)
  if (!templateParameters(urlTemplate).length) throw new Error('Add at least one {{parameter}} to the URL.')
  return { name, description, urlTemplate }
}

function customDefinition(config: CustomHttpToolConfig): Tool {
  const properties = Object.fromEntries(templateParameters(config.urlTemplate).map((name) => [
    name,
    { type: 'string', description: `Value for ${name}` },
  ]))
  return {
    name: config.name,
    description: config.description,
    parameters: {
      type: 'object',
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    } as Tool['parameters'],
  }
}

async function executeCustomTool(
  config: CustomHttpToolConfig,
  arguments_: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string> {
  const url = config.urlTemplate.replace(/\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}/g, (_match, name) => {
    const value = arguments_[name]
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${config.name} requires ${name}.`)
    return encodeURIComponent(value.trim())
  })
  approvedTemplateUrl(url)
  const response = await fetchWithTimeout(url, { headers: { Accept: 'application/json, text/plain' } }, signal)
  if (!response.ok) throw new Error(`${config.name} failed with HTTP ${response.status}.`)
  return truncateOutput(await response.text(), config.name)
}

function customExecutable(config: CustomHttpToolConfig): ExecutableTool {
  return {
    definition: customDefinition(config),
    activity: () => `calling ${config.name}: ${approvedTemplateUrl(config.urlTemplate).hostname}`,
    execute: (arguments_, signal) => executeCustomTool(config, arguments_, signal),
  }
}

const BUILTIN_TOOLS = new Map<string, ExecutableTool>([
  [WEB_SEARCH_TOOL_ID, {
    definition: {
      name: WEB_SEARCH_TOOL_ID,
      description: 'Search the web for current information. Returns titles, URLs, and snippets. Use it when the answer may depend on recent or externally verifiable facts.',
      parameters: Type.Object({
        query: Type.String({ description: 'The focused web search query' }),
        count: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_RESULTS })),
      }),
    },
    activity: (arguments_) => {
      const query = typeof arguments_.query === 'string' ? arguments_.query.trim() : ''
      return query ? `searching: ${query}` : 'searching the web'
    },
    execute: webSearch,
  }],
  [WEB_FETCH_TOOL_ID, {
    definition: {
      name: WEB_FETCH_TOOL_ID,
      description: 'Read a public webpage as clean, LLM-friendly Markdown. Use after web_search when a result needs verification or more detail.',
      parameters: Type.Object({
        url: Type.String({ description: 'The public HTTP or HTTPS webpage URL to read' }),
      }),
    },
    activity: (arguments_) => {
      try {
        return `fetching: ${validatePublicWebUrl(arguments_.url).hostname}`
      } catch {
        return 'fetching webpage'
      }
    },
    execute: webFetch,
  }],
])

export function resolveTools(
  enabledToolIds: string[],
  customTools: CustomHttpToolConfig[] = [],
): ExecutableTool[] {
  const builtins = enabledToolIds.flatMap((id) => {
    const tool = BUILTIN_TOOLS.get(id)
    return tool ? [tool] : []
  })
  const custom = customTools
    .filter((config) => enabledToolIds.includes(config.id))
    .map(customExecutable)
  return [...builtins, ...custom]
}
