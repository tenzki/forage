// Metadata behind unfurl cards.
//
// Deliberately in-memory: nothing fetched here is persisted, so no preview text
// reaches the document, the event log, or the sync server. A cold start
// re-fetches.
//
// The fetch goes through Jina Reader, which the Tauri HTTP capability already
// allows (`https://r.jina.ai/**` in capabilities/default.json), so previews need
// no new network egress. Reader returns Markdown rather than raw HTML, which is
// why this reads `Title:` headers instead of `<meta property="og:*">`.

import { fetchWithTimeout, validatePublicWebUrl } from '../agent/tools'

const MAX_TITLE = 120
const MAX_DESCRIPTION = 200

export interface LinkPreview {
  status: 'loading' | 'ready' | 'error'
  host: string
  title?: string
  description?: string
}

const cache = new Map<string, LinkPreview>()
const inFlight = new Map<string, Promise<LinkPreview>>()

function clamp(value: string, limit: number): string {
  const text = value.replace(/\s+/gu, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text
}

/** Pull a title and a lead sentence out of Jina Reader's Markdown response. */
export function parseReaderResponse(body: string): { title?: string; description?: string } {
  const lines = body.split('\n')
  const contentAt = lines.findIndex((line) => /^Markdown Content:/u.test(line))
  const headerLines = contentAt === -1 ? lines.slice(0, 8) : lines.slice(0, contentAt)

  const titleLine = headerLines.find((line) => /^Title:/u.test(line))
  const title = titleLine ? clamp(titleLine.replace(/^Title:/u, ''), MAX_TITLE) : undefined

  const body_ = contentAt === -1 ? [] : lines.slice(contentAt + 1)
  const description = body_
    .map((line) => line.trim())
    // Skip Markdown chrome — headings, images, links-only lines, rules, quotes.
    .find((line) => line.length > 0 && !/^(#{1,6}\s|!\[|\[|[-*_=]{3,}|>|\||```)/u.test(line))
  return {
    title: title || undefined,
    description: description ? clamp(description, MAX_DESCRIPTION) : undefined,
  }
}

async function fetchPreview(href: string, host: string): Promise<LinkPreview> {
  try {
    const target = validatePublicWebUrl(href)
    const response = await fetchWithTimeout(`https://r.jina.ai/${target.toString()}`, {
      headers: { Accept: 'text/plain' },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const { title, description } = parseReaderResponse(await response.text())
    return { status: 'ready', host, title, description }
  } catch {
    return { status: 'error', host }
  }
}

function hostOf(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./u, '')
  } catch {
    return href
  }
}

/** Whatever is known about a link right now, without waiting. */
export function readPreview(href: string): LinkPreview {
  return cache.get(href) ?? { status: 'loading', host: hostOf(href) }
}

/**
 * Ensure a preview is being fetched. Concurrent cards for one URL share a single
 * request. `onSettled` fires once the entry reaches a terminal state, including
 * immediately when it is already cached.
 */
export function ensurePreview(href: string, onSettled?: () => void): LinkPreview {
  const cached = cache.get(href)
  if (cached && cached.status !== 'loading') return cached

  if (!inFlight.has(href)) {
    const host = hostOf(href)
    const loading: LinkPreview = { status: 'loading', host }
    cache.set(href, loading)
    const request = fetchPreview(href, host).then((preview) => {
      cache.set(href, preview)
      inFlight.delete(href)
      return preview
    })
    inFlight.set(href, request)
  }

  if (onSettled) void inFlight.get(href)?.then(onSettled)
  return cache.get(href) ?? { status: 'loading', host: hostOf(href) }
}

/** Test seam. */
export function resetPreviewCache(): void {
  cache.clear()
  inFlight.clear()
}
