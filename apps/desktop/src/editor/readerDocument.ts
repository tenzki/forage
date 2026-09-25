// Reader view for the link peek.
//
// The page is fetched through Jina Reader — the same allowed egress as hover
// previews (see linkPreview.ts) — which returns the article as Markdown. That
// Markdown is parsed into a small block model here and rendered as plain React
// elements, never as HTML, so nothing from the remote page can run or style
// itself inside the app. Like previews, nothing fetched here is persisted.

import { fetchWithTimeout, validatePublicWebUrl } from '../agent/tools'

export type ReaderInline =
  | { type: 'text'; text: string }
  | { type: 'strong' | 'em'; children: ReaderInline[] }
  | { type: 'code'; text: string }
  | { type: 'link'; href: string; children: ReaderInline[] }

export type ReaderBlock =
  | { type: 'heading'; level: 1 | 2 | 3 | 4; content: ReaderInline[] }
  | { type: 'paragraph'; content: ReaderInline[] }
  | { type: 'quote'; content: ReaderInline[] }
  | { type: 'list'; ordered: boolean; items: ReaderInline[][] }
  | { type: 'code'; text: string }
  | { type: 'rule' }

export interface ReaderDocument {
  href: string
  host: string
  title: string
  published?: string
  blocks: ReaderBlock[]
  minutes: number
  fetchedAt: number
}

const WORDS_PER_MINUTE = 230
const MAX_BLOCKS = 400

function hostOf(href: string): string {
  try {
    return new URL(href).hostname.replace(/^www\./u, '')
  } catch {
    return href
  }
}

function safeHref(value: string, base: string): string | null {
  try {
    const url = new URL(value, base)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

/** Parse the inline Markdown Jina emits: links, emphasis and code. Images are dropped. */
export function parseInline(text: string, base: string): ReaderInline[] {
  const out: ReaderInline[] = []
  let buffer = ''
  const flush = () => {
    if (buffer) out.push({ type: 'text', text: buffer })
    buffer = ''
  }
  let index = 0
  while (index < text.length) {
    const rest = text.slice(index)
    // Images, including linked images: remote images are blocked by the CSP.
    const image = /^!\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/u.exec(rest)
    if (image) {
      index += image[0].length
      continue
    }
    const link = /^\[((?:[^[\]]|\[[^\]]*\])*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/u.exec(rest)
    if (link) {
      flush()
      const href = safeHref(link[2]!, base)
      const children = parseInline(link[1]!, base)
      if (href && children.length) out.push({ type: 'link', href, children })
      else out.push(...children)
      index += link[0].length
      continue
    }
    const code = /^`([^`]+)`/u.exec(rest)
    if (code) {
      flush()
      out.push({ type: 'code', text: code[1]! })
      index += code[0].length
      continue
    }
    const strong = /^(\*\*|__)(?=\S)(.+?)(?<=\S)\1/u.exec(rest)
    if (strong) {
      flush()
      out.push({ type: 'strong', children: parseInline(strong[2]!, base) })
      index += strong[0].length
      continue
    }
    const em = /^(\*|_)(?=\S)(.+?)(?<=\S)\1(?![\w*])/u.exec(rest)
    if (em && (index === 0 || !/\w/u.test(text[index - 1]!))) {
      flush()
      out.push({ type: 'em', children: parseInline(em[2]!, base) })
      index += em[0].length
      continue
    }
    buffer += text[index]
    index += 1
  }
  flush()
  return out
}

function inlineText(nodes: ReaderInline[]): string {
  return nodes.map((node) => ('text' in node ? node.text : inlineText(node.children))).join('')
}

/** Split Jina's Markdown body into blocks. */
export function parseReaderMarkdown(markdown: string, base: string): ReaderBlock[] {
  const blocks: ReaderBlock[] = []
  const lines = markdown.replace(/\r\n?/gu, '\n').split('\n')
  let paragraph: string[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  const push = (block: ReaderBlock) => {
    if (blocks.length < MAX_BLOCKS) blocks.push(block)
  }
  const flushParagraph = () => {
    const text = paragraph.join(' ').trim()
    paragraph = []
    if (!text) return
    const content = parseInline(text, base)
    if (inlineText(content).trim()) push({ type: 'paragraph', content })
  }
  const flushList = () => {
    if (!list) return
    const items = list.items.map((item) => parseInline(item, base)).filter((item) => inlineText(item).trim())
    if (items.length) push({ type: 'list', ordered: list.ordered, items })
    list = null
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    const trimmed = line.trim()
    if (trimmed.startsWith('```')) {
      flushParagraph()
      flushList()
      const code: string[] = []
      index += 1
      while (index < lines.length && !lines[index]!.trim().startsWith('```')) {
        code.push(lines[index]!)
        index += 1
      }
      push({ type: 'code', text: code.join('\n') })
      continue
    }
    if (!trimmed) {
      flushParagraph()
      flushList()
      continue
    }
    // Setext headings: a line underlined with === or ---.
    const next = lines[index + 1]?.trim() ?? ''
    if (paragraph.length === 0 && !list && /^(=+|-+)$/u.test(next) && !/^[-*+]\s/u.test(trimmed)) {
      const content = parseInline(trimmed, base)
      if (inlineText(content).trim()) push({ type: 'heading', level: next.startsWith('=') ? 1 : 2, content })
      index += 1
      continue
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*$/u.exec(trimmed)
    if (heading) {
      flushParagraph()
      flushList()
      const content = parseInline(heading[2]!, base)
      if (inlineText(content).trim()) {
        push({ type: 'heading', level: Math.min(4, heading[1]!.length) as 1 | 2 | 3 | 4, content })
      }
      continue
    }
    if (/^([-*_])(\s*\1){2,}$/u.test(trimmed)) {
      flushParagraph()
      flushList()
      push({ type: 'rule' })
      continue
    }
    if (trimmed.startsWith('|')) continue
    if (trimmed.startsWith('>')) {
      flushParagraph()
      flushList()
      const quote = [trimmed.replace(/^>\s?/u, '')]
      while (index + 1 < lines.length && lines[index + 1]!.trim().startsWith('>')) {
        index += 1
        quote.push(lines[index]!.trim().replace(/^>\s?/u, ''))
      }
      const content = parseInline(quote.join(' '), base)
      if (inlineText(content).trim()) push({ type: 'quote', content })
      continue
    }
    const item = /^(?:([-*+])|(\d+)[.)])\s+(.*)$/u.exec(trimmed)
    if (item) {
      flushParagraph()
      const ordered = Boolean(item[2])
      if (!list || list.ordered !== ordered) {
        flushList()
        list = { ordered, items: [] }
      }
      list.items.push(item[3]!)
      continue
    }
    if (list && /^\s{2,}/u.test(line)) {
      list.items[list.items.length - 1] += ` ${trimmed}`
      continue
    }
    flushList()
    paragraph.push(trimmed)
  }
  flushParagraph()
  flushList()
  return blocks
}

function blockWords(block: ReaderBlock): number {
  const text = block.type === 'list'
    ? block.items.map(inlineText).join(' ')
    : block.type === 'code' ? block.text
      : block.type === 'rule' ? '' : inlineText(block.content)
  return text.split(/\s+/u).filter(Boolean).length
}

/** Turn a Jina Reader response into a reader document. */
export function parseReaderResponse(body: string, href: string, fetchedAt = Date.now()): ReaderDocument {
  const lines = body.split('\n')
  const contentAt = lines.findIndex((line) => /^Markdown Content:/u.test(line))
  const header = contentAt === -1 ? [] : lines.slice(0, contentAt)
  const field = (name: string) => header.find((line) => line.startsWith(`${name}:`))?.slice(name.length + 1).trim()
  const markdown = contentAt === -1 ? body : lines.slice(contentAt + 1).join('\n')
  const source = field('URL Source')
  const base = source && safeHref(source, href) ? source : href
  let blocks = parseReaderMarkdown(markdown, base)
  const title = field('Title') || (blocks[0]?.type === 'heading' ? inlineText(blocks[0].content) : hostOf(href))
  // The article usually repeats its title as the first heading; the header shows it already.
  if (blocks[0]?.type === 'heading' && inlineText(blocks[0].content).trim() === title.trim()) blocks = blocks.slice(1)
  const words = blocks.reduce((total, block) => total + blockWords(block), 0)
  const published = field('Published Time')
  return {
    href,
    host: hostOf(href),
    title,
    ...(published ? { published } : {}),
    blocks,
    minutes: Math.max(1, Math.round(words / WORDS_PER_MINUTE)),
    fetchedAt,
  }
}

export async function fetchReaderDocument(href: string, signal?: AbortSignal): Promise<ReaderDocument> {
  const target = validatePublicWebUrl(href)
  const response = await fetchWithTimeout(`https://r.jina.ai/${target.toString()}`, {
    headers: { Accept: 'text/plain' },
  }, signal)
  if (!response.ok) throw new Error(`The site returned HTTP ${response.status}.`)
  return parseReaderResponse(await response.text(), target.toString())
}
