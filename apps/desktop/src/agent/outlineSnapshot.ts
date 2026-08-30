import type { Node as ProseMirrorNode } from '@tiptap/pm/model'

export interface OutlineNodeSnapshot {
  nodeId: string
  text: string
  depth: number
  /** Texts of ancestor nodes, nearest first. */
  ancestorTexts: string[]
}

export interface SnapshotSearchResult {
  nodeId: string
  text: string
  depth: number
  context: string
  matchField: 'text' | 'ancestor'
}

/**
 * Build a searchable snapshot of the outline at a given point. Each listItem
 * that has a nodeId and non-empty text becomes one entry with its ancestry.
 * The snapshot is bounded to `maxBytes` of JSON text (default 300 KB) so it
 * fits comfortably inside Pi's 512 KB payload limit after base64 encoding.
 */
export function buildOutlineSnapshot(
  doc: ProseMirrorNode,
  maxBytes = 300_000,
): OutlineNodeSnapshot[] {
  const entries: OutlineNodeSnapshot[] = []
  // Stack of ancestor listItem texts, tracked by node end position.
  const ancestors: Array<{ text: string; end: number }> = []

  doc.descendants((node, pos) => {
    if (node.type.name !== 'listItem' || typeof node.attrs.nodeId !== 'string') return
    // Pop ancestors that we've left.
    while (ancestors.length && pos >= ancestors[ancestors.length - 1].end)
      ancestors.pop()

    const text = node.firstChild?.textContent?.trim() ?? ''
    // Skip empty AI placeholder bullets.
    if (!text && node.attrs.nodeType === 'ai') return

    entries.push({
      nodeId: node.attrs.nodeId,
      text,
      depth: ancestors.length,
      ancestorTexts: ancestors.map((a) => a.text),
    })
    ancestors.push({ text, end: pos + node.nodeSize })
  })

  // Trim to byte budget (crude but fast — each char ≤ 1 byte in practice for
  // mostly-ASCII outlines, but JSON overhead + multi-byte chars mean we
  // overshoot slightly; the payload limit has headroom).
  let bytes = 2 // outer []
  let endIndex = entries.length
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    bytes += JSON.stringify(entry).length + (i > 0 ? 1 : 0) // comma
    if (bytes > maxBytes) {
      endIndex = i
      break
    }
  }
  return entries.slice(0, endIndex)
}

/**
 * Full-text search over the snapshot. Returns nodes whose text or ancestor
 * text contains the query (case-insensitive). Results are ranked by field
 * (text matches first, then by depth shallow-first).
 */
export function searchSnapshot(
  snapshot: OutlineNodeSnapshot[],
  query: string,
  maxResults = 10,
): SnapshotSearchResult[] {
  const lower = query.toLowerCase().trim()
  if (!lower) return []

  const withScore: Array<{ result: SnapshotSearchResult; score: number }> = []

  for (const node of snapshot) {
    const textLower = node.text.toLowerCase()
    // Text match (primary).
    if (textLower.includes(lower)) {
      withScore.push({
        result: {
          nodeId: node.nodeId,
          text: node.text,
          depth: node.depth,
          context: ancestorLine(node),
          matchField: 'text',
        },
        score: 0 + node.depth, // shallow = better
      })
      continue
    }
    // Ancestor match (secondary).
    const ancIndex = node.ancestorTexts.findIndex((a) => a.toLowerCase().includes(lower))
    if (ancIndex !== -1) {
      withScore.push({
        result: {
          nodeId: node.nodeId,
          text: node.text,
          depth: node.depth,
          context: ancestorLine(node),
          matchField: 'ancestor',
        },
        score: 1000 + node.depth, // always ranked below text matches
      })
    }
  }

  withScore.sort((a, b) => a.score - b.score)

  return withScore.slice(0, Math.max(1, Math.min(maxResults, 20))).map((item) => item.result)
}

function ancestorLine(node: OutlineNodeSnapshot): string {
  const parts = [...node.ancestorTexts].reverse() // root first
  parts.push(node.text)
  return parts.join(' / ')
}

/** Format results for the LLM as readable text. */
export function formatSnapshotResults(
  results: SnapshotSearchResult[],
  query: string,
): string {
  if (!results.length) return `No existing nodes match "${query}".`
  const header = `Found ${results.length} matching node(s) for "${query}":\n\n`
  const body = results
    .map((r, i) => {
      const tag = r.matchField === 'ancestor' ? ' (ancestor match)' : ''
      return `${i + 1}. [${r.depth}] ${r.text}${tag}\n   Path: ${r.context}`
    })
    .join('\n\n')
  return header + body
}