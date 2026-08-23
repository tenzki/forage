import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { ContextSelector, SkillContextStrategy } from './definitions'

interface OutlineEntry {
  id: string
  text: string
  nodeType: string
  pos: number
  end: number
  depth: number
  parent: OutlineEntry | null
  children: OutlineEntry[]
}

export interface ResolvedSkillContext {
  anchorNodeId: string
  invocationNodeId: string
  nodeIds: string[]
  lines: string[]
  nodeCount: number
  characterCount: number
  truncated: boolean
}

function outlineEntries(doc: ProseMirrorNode): { ordered: OutlineEntry[]; roots: OutlineEntry[] } {
  const ordered: OutlineEntry[] = []
  const roots: OutlineEntry[] = []
  const stack: OutlineEntry[] = []
  doc.descendants((node, pos) => {
    if (node.type.name !== 'listItem' || typeof node.attrs.nodeId !== 'string') return
    while (stack.length && pos >= stack[stack.length - 1].end) stack.pop()
    const parent = stack[stack.length - 1] ?? null
    const entry: OutlineEntry = {
      id: node.attrs.nodeId,
      text: node.firstChild?.textContent?.trim() ?? '',
      nodeType: typeof node.attrs.nodeType === 'string' ? node.attrs.nodeType : 'user',
      pos,
      end: pos + node.nodeSize,
      depth: parent ? parent.depth + 1 : 0,
      parent,
      children: [],
    }
    if (parent) parent.children.push(entry)
    else roots.push(entry)
    ordered.push(entry)
    stack.push(entry)
  })
  return { ordered, roots }
}

function siblingsOf(entry: OutlineEntry, roots: OutlineEntry[]): OutlineEntry[] {
  return entry.parent?.children ?? roots
}

function resolveAnchor(
  invocation: OutlineEntry,
  roots: OutlineEntry[],
  strategy: SkillContextStrategy,
): OutlineEntry {
  if (strategy.anchor === 'invocation') return invocation
  if (strategy.anchor === 'parent') {
    if (!invocation.parent) throw new Error('This skill needs to be invoked from a child bullet.')
    return invocation.parent
  }
  const siblings = siblingsOf(invocation, roots)
  const previous = siblings[siblings.indexOf(invocation) - 1]
  if (!previous) throw new Error('This skill needs a previous sibling branch.')
  return previous
}

function addDescendants(entry: OutlineEntry, selected: Set<string>, maxDepth?: number): void {
  const visit = (candidate: OutlineEntry, relativeDepth: number) => {
    if (maxDepth !== undefined && relativeDepth > maxDepth) return
    selected.add(candidate.id)
    candidate.children.forEach((child) => visit(child, relativeDepth + 1))
  }
  entry.children.forEach((child) => visit(child, 1))
}

function applySelector(
  selector: ContextSelector,
  anchor: OutlineEntry,
  roots: OutlineEntry[],
  selected: Set<string>,
): void {
  if (selector.kind === 'self') selected.add(anchor.id)
  if (selector.kind === 'ancestors') {
    let candidate = anchor.parent
    let depth = 1
    while (candidate && (selector.maxDepth === undefined || depth <= selector.maxDepth)) {
      selected.add(candidate.id)
      candidate = candidate.parent
      depth += 1
    }
  }
  if (selector.kind === 'descendants') addDescendants(anchor, selected, selector.maxDepth)
  if (selector.kind !== 'siblings') return
  const siblings = siblingsOf(anchor, roots)
  const anchorIndex = siblings.indexOf(anchor)
  siblings.forEach((sibling, index) => {
    const included = selector.position === 'both'
      || (selector.position === 'before' && index < anchorIndex)
      || (selector.position === 'after' && index > anchorIndex)
    if (!included || sibling === anchor) return
    selected.add(sibling.id)
    if (selector.includeSubtrees) addDescendants(sibling, selected, selector.maxDepth)
  })
}

function selectedEntries(
  ordered: OutlineEntry[],
  selected: Set<string>,
  invocationNodeId: string,
  strategy: SkillContextStrategy,
): OutlineEntry[] {
  return ordered.filter((entry) => {
    if (!selected.has(entry.id)) return false
    if (strategy.filters.excludeInvocation && entry.id === invocationNodeId) return false
    if (!strategy.filters.includeAiNodes && entry.nodeType === 'ai') return false
    return strategy.filters.includeEmptyNodes || Boolean(entry.text)
  })
}

function formatWithinBudget(
  entries: OutlineEntry[],
  strategy: SkillContextStrategy,
): { entries: OutlineEntry[]; lines: string[]; truncated: boolean } {
  const minimumDepth = Math.min(...entries.map((entry) => entry.depth))
  const allLines = entries.map((entry) => `${'  '.repeat(entry.depth - minimumDepth)}- ${entry.text}`)
  const overBudget = entries.length > strategy.budget.maxNodes
    || allLines.reduce((total, line) => total + line.length, 0) > strategy.budget.maxCharacters
  if (overBudget && strategy.budget.overflow === 'block') {
    throw new Error(`Selected context exceeds this skill’s ${strategy.budget.maxNodes}-node or ${strategy.budget.maxCharacters.toLocaleString()}-character limit.`)
  }
  const keptEntries: OutlineEntry[] = []
  const lines: string[] = []
  let characters = 0
  for (let index = 0; index < entries.length; index += 1) {
    if (keptEntries.length >= strategy.budget.maxNodes) break
    const line = allLines[index]
    if (characters + line.length > strategy.budget.maxCharacters) {
      if (!keptEntries.length) {
        keptEntries.push(entries[index])
        lines.push(`${line.slice(0, strategy.budget.maxCharacters - 1)}…`)
      }
      break
    }
    keptEntries.push(entries[index])
    lines.push(line)
    characters += line.length
  }
  return { entries: keptEntries, lines, truncated: overBudget }
}

export function resolveSkillContext(
  doc: ProseMirrorNode,
  invocationNodeId: string,
  strategy: SkillContextStrategy,
): ResolvedSkillContext {
  const { ordered, roots } = outlineEntries(doc)
  const invocation = ordered.find((entry) => entry.id === invocationNodeId)
  if (!invocation) throw new Error('Could not locate the skill invocation bullet.')
  const anchor = resolveAnchor(invocation, roots, strategy)
  const selected = new Set<string>()
  strategy.selectors.forEach((selector) => applySelector(selector, anchor, roots, selected))
  const entries = selectedEntries(ordered, selected, invocationNodeId, strategy)
  if (!entries.length) throw new Error('This skill’s context strategy selected no outline nodes.')
  const formatted = formatWithinBudget(entries, strategy)
  return {
    anchorNodeId: anchor.id,
    invocationNodeId,
    nodeIds: formatted.entries.map((entry) => entry.id),
    lines: formatted.lines,
    nodeCount: formatted.entries.length,
    characterCount: formatted.lines.reduce((total, line) => total + line.length, 0),
    truncated: formatted.truncated,
  }
}
