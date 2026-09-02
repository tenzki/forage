import { untrustedSourceMaterialSchema, type RuntimeTool, type UntrustedSourceMaterial } from '@forage/agent-runtime'
import { inspectPublicUrl, type PublicSourceIdentity } from './sourceUrl.js'
import type { TranscriptProvider } from './transcript.js'

export interface PublicReaderResult { canonicalUrl: string; content: string; title?: string; author?: string; publishedAt?: string }
export interface PublicReader { read(url: string, signal: AbortSignal): Promise<PublicReaderResult> }

export class DuckDuckGoSearchProvider {
  constructor(private readonly fetch: typeof globalThis.fetch = globalThis.fetch) {}
  async search(query: string, signal: AbortSignal): Promise<unknown> {
    const response = await this.fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      method: 'GET', signal, headers: { accept: 'text/html' },
    })
    if (response.status === 429) throw new Error('Web search was rate limited.')
    if (!response.ok) throw new Error('Web search is temporarily unavailable.')
    const html = await response.text()
    if (html.length > 1_000_000) throw new Error('Web search response is too large.')
    const results: Array<{ title: string; url: string }> = []
    const pattern = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
    for (const match of html.matchAll(pattern)) {
      const url = decodeHtml(match[1] ?? '')
      const title = decodeHtml((match[2] ?? '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
      if (url && title) results.push({ title: title.slice(0, 300), url: url.slice(0, 2_000) })
      if (results.length >= 10) break
    }
    return { trust: 'untrusted', query, results }
  }
}

interface ReaderOptions {
  fetch?: typeof globalThis.fetch
  resolve?: (hostname: string) => Promise<string[]>
  maxCharacters?: number
  maxRedirects?: number
}

export class BoundedPublicReader implements PublicReader {
  private readonly fetch: typeof globalThis.fetch
  private readonly maximum: number
  private readonly maxRedirects: number
  constructor(private readonly options: ReaderOptions = {}) {
    this.fetch = options.fetch ?? globalThis.fetch
    this.maximum = Math.max(1, Math.min(options.maxCharacters ?? 100_000, 100_000))
    this.maxRedirects = Math.max(0, Math.min(options.maxRedirects ?? 3, 5))
  }

  async read(submittedUrl: string, signal: AbortSignal): Promise<PublicReaderResult> {
    let inspected = await inspectPublicUrl(submittedUrl, { resolve: this.options.resolve })
    for (let redirects = 0; redirects <= this.maxRedirects; redirects += 1) {
      const response = await this.fetch(inspected.canonicalUrl, {
        method: 'GET', redirect: 'manual', signal, headers: { accept: 'text/plain,text/html;q=0.9' },
      })
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location')
        if (!location || redirects === this.maxRedirects) throw new Error('Public reader redirect limit was exceeded.')
        inspected = await inspectPublicUrl(new URL(location, inspected.canonicalUrl).toString(), { resolve: this.options.resolve })
        continue
      }
      if (response.status === 429) throw new Error('Public reader was rate limited.')
      if (!response.ok) throw new Error(response.status >= 500 ? 'Public reader is temporarily unavailable.' : 'Public source is unavailable.')
      const declared = Number(response.headers.get('content-length') ?? 0)
      if (declared > this.maximum * 4) throw new Error('Public source response is too large.')
      const content = await response.text()
      if (content.length > this.maximum) throw new Error('Public source response is too large.')
      return { canonicalUrl: inspected.canonicalUrl, content }
    }
    throw new Error('Public reader redirect limit was exceeded.')
  }
}

interface RegistryOptions {
  reader?: PublicReader
  transcript?: TranscriptProvider
  inspect?: (url: string) => Promise<PublicSourceIdentity>
  outlineSearch?: (query: string, signal: AbortSignal) => Promise<unknown>
  webSearch?: (query: string, signal: AbortSignal) => Promise<unknown>
  imageGeneration?: (prompt: string, signal: AbortSignal) => Promise<unknown>
}

export function createServerToolRegistry(options: RegistryOptions): RuntimeTool[] {
  const inspect = options.inspect ?? ((url: string) => inspectPublicUrl(url))
  const tools: RuntimeTool[] = []
  if (options.reader) {
    tools.push(sourceReaderTool('web_read', 'Read public webpage', 'Reads a bounded public webpage.', options.reader, inspect, false))
    tools.push(sourceReaderTool('web_fetch', 'Fetch public webpage', 'Reads a bounded public webpage.', options.reader, inspect, false))
    tools.push(sourceReaderTool('x_read', 'Read X post', 'Reads a recognized public X/Twitter status.', options.reader, inspect, true))
  }
  if (options.transcript) {
    tools.push({
      id: 'youtube_transcript', name: 'YouTube transcript', description: 'Retrieves a bounded transcript for a public YouTube video.',
      execute: async (arguments_, signal) => {
        const url = urlArgument(arguments_)
        const identity = await inspect(url)
        if (identity.type !== 'youtube' || !identity.identity) throw new Error('A recognized YouTube video URL is required.')
        const transcript = await options.transcript!.transcript({ videoId: identity.identity, canonicalUrl: identity.canonicalUrl }, signal)
        return untrustedSourceMaterialSchema.parse({
          trust: 'untrusted', sourceType: 'youtube_transcript', canonicalUrl: identity.canonicalUrl,
          content: transcript.text, metadata: {
            videoId: identity.identity, submittedUrl: identity.submittedUrl,
            ...(transcript.language ? { language: transcript.language } : {}),
          },
        })
      },
    })
  }
  if (options.webSearch) tools.push(simpleStringTool('web_search', 'Web search', 'Searches public web indexes.', 'query', options.webSearch))
  if (options.outlineSearch) {
    tools.push(simpleStringTool('outline_search', 'Outline search', 'Searches the current outline snapshot.', 'query', options.outlineSearch))
    tools.push(simpleStringTool('search_outline', 'Search outline', 'Searches the current outline snapshot.', 'query', options.outlineSearch))
  }
  if (options.imageGeneration) tools.push(simpleStringTool('generate_image', 'Generate image', 'Creates an image asset for the result.', 'prompt', options.imageGeneration))
  return tools
}

function sourceReaderTool(
  id: 'web_read' | 'web_fetch' | 'x_read', name: string, description: string, reader: PublicReader,
  inspect: (url: string) => Promise<PublicSourceIdentity>, xOnly: boolean,
): RuntimeTool {
  return {
    id, name, description,
    execute: async (arguments_, signal): Promise<UntrustedSourceMaterial> => {
      const url = urlArgument(arguments_)
      const identity = await inspect(url)
      if (xOnly && identity.type !== 'x') throw new Error('A recognized X/Twitter status URL is required.')
      const page = await reader.read(identity.canonicalUrl, signal)
      const sourceType = xOnly ? 'x_post' : 'webpage'
      return untrustedSourceMaterialSchema.parse({
        trust: 'untrusted', sourceType, canonicalUrl: page.canonicalUrl, content: page.content,
        metadata: {
          submittedUrl: identity.submittedUrl,
          ...(identity.identity ? { identity: identity.identity } : {}),
          ...(page.title ? { title: page.title } : {}),
          ...(page.author ? { author: page.author } : {}),
          ...(page.publishedAt ? { publishedAt: page.publishedAt } : {}),
        },
      })
    },
  }
}

function simpleStringTool(
  id: string, name: string, description: string, argumentName: string,
  execute: (value: string, signal: AbortSignal) => Promise<unknown>,
): RuntimeTool {
  return {
    id, name, description,
    execute: (arguments_, signal) => {
      const value = arguments_[argumentName]
      if (typeof value !== 'string' || !value.trim() || value.length > 20_000) throw new Error(`${argumentName} is required.`)
      return execute(value.trim(), signal)
    },
  }
}

function urlArgument(arguments_: Record<string, unknown>): string {
  const url = arguments_.url
  if (typeof url !== 'string' || !url.trim() || url.length > 2_000) throw new Error('A bounded URL is required.')
  return url.trim()
}

function decodeHtml(value: string): string {
  return value.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
}
