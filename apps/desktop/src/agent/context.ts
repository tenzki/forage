import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import {
  extensionSkillContextSnapshotSchema,
  type ExtensionSkillContextNode,
  type ExtensionSkillContextSnapshot,
} from '@forage/agent-runtime'
import { collectInternalLinkReferences } from '../editor/internalLinks'

export const AGENT_CONTEXT_MAX_NODES = 100
export const AGENT_CONTEXT_MAX_CHARACTERS = 40_000

interface OutlineEntry {
  id: string
  text: string
  depth: number
  parent: OutlineEntry | null
  children: OutlineEntry[]
  node: ProseMirrorNode
}

export interface ResolvedExtensionSkillContext {
  snapshot: ExtensionSkillContextSnapshot
  localNodeIds: string[]
  referencedNodeIds: string[]
  admittedReferenceIds: string[]
}

export interface ReferencedContextGroup {
  targetId: string
  label: string
  nodeIds: string[]
  lines: string[]
}

export interface ResolvedAgentContext {
  invocationNodeId: string
  localRootNodeId: string | null
  localNodeIds: string[]
  referencedNodeIds: string[]
  referencedGroups: ReferencedContextGroup[]
  serialized: string
  lines: string[]
  nodeCount: number
  characterCount: number
}


function outlineEntries(doc: ProseMirrorNode): { ordered: OutlineEntry[]; byId: Map<string, OutlineEntry> } {
  const ordered: OutlineEntry[] = []
  const byId = new Map<string, OutlineEntry>()
  const stack: Array<{ entry: OutlineEntry; end: number }> = []
  doc.descendants((node, pos) => {
    if (node.type.name !== 'listItem' || typeof node.attrs.nodeId !== 'string') return
    while (stack.length && pos >= stack[stack.length - 1].end) stack.pop()
    const parent = stack[stack.length - 1]?.entry ?? null
    const entry: OutlineEntry = {
      id: node.attrs.nodeId,
      text: node.firstChild?.textContent?.trim() ?? '',
      depth: parent ? parent.depth + 1 : 0,
      parent,
      children: [],
      node,
    }
    parent?.children.push(entry)
    ordered.push(entry)
    byId.set(entry.id, entry)
    stack.push({ entry, end: pos + node.nodeSize })
  })
  return { ordered, byId }
}

function subtree(root: OutlineEntry): OutlineEntry[] {
  const entries: OutlineEntry[] = []
  const visit = (entry: OutlineEntry) => {
    entries.push(entry)
    entry.children.forEach(visit)
  }
  visit(root)
  return entries
}

function formatEntries(entries: OutlineEntry[], baseDepth: number): string[] {
  return entries.map((entry) => (
    `${'  '.repeat(Math.max(0, entry.depth - baseDepth))}- ${entry.text || '(empty)'}`
  ))
}

function localEntries(invocation: OutlineEntry): { root: OutlineEntry | null; entries: OutlineEntry[] } {
  const parent = invocation.parent
  if (!parent) return { root: null, entries: [] }
  const ancestorPath: OutlineEntry[] = []
  let ancestor: OutlineEntry | null = parent
  while (ancestor) {
    ancestorPath.unshift(ancestor)
    ancestor = ancestor.parent
  }
  const excluded = new Set(subtree(invocation).map((entry) => entry.id))
  const parentBranch = subtree(parent).filter((entry) => !excluded.has(entry.id))
  return {
    root: ancestorPath[0],
    entries: [...ancestorPath.slice(0, -1), ...parentBranch],
  }
}

function referencedGroups(
  invocation: OutlineEntry,
  byId: Map<string, OutlineEntry>,
  local: OutlineEntry[],
): ReferencedContextGroup[] {
  const references = collectInternalLinkReferences(invocation.node.firstChild ?? invocation.node)
  const covered = new Set(local.map((entry) => entry.id))
  const excluded = new Set(subtree(invocation).map((entry) => entry.id))
  const groups: ReferencedContextGroup[] = []

  for (const reference of references) {
    const target = byId.get(reference.targetId)
    if (!target) {
      const label = reference.label.trim() || reference.targetId
      throw new Error(`Referenced node “${label}” no longer exists.`)
    }
    if (covered.has(target.id) || excluded.has(target.id)) continue
    const entries = subtree(target).filter((entry) => (
      !covered.has(entry.id) && !excluded.has(entry.id)
    ))
    if (!entries.length) continue
    entries.forEach((entry) => covered.add(entry.id))
    groups.push({
      targetId: target.id,
      label: target.text || reference.label.trim() || 'Untitled',
      nodeIds: entries.map((entry) => entry.id),
      lines: formatEntries(entries, target.depth),
    })
  }
  return groups
}

function serializeContext(local: OutlineEntry[], groups: ReferencedContextGroup[]): string {
  const sections: string[] = []
  if (local.length) {
    sections.push(`Local branch:\n${formatEntries(local, local[0].depth).join('\n')}`)
  }
  if (groups.length) {
    const references = groups.map((group) => (
      `[${group.label}]\n${group.lines.join('\n')}`
    )).join('\n\n')
    sections.push(`Referenced nodes:\n${references}`)
  }
  return sections.join('\n\n')
}

function assertWithinContextBudget(nodeCount: number, characterCount: number): void {
  if (nodeCount > AGENT_CONTEXT_MAX_NODES || characterCount > AGENT_CONTEXT_MAX_CHARACTERS) {
    throw new Error(
      `Agent context exceeds the safety limit of ${AGENT_CONTEXT_MAX_NODES} nodes or ${AGENT_CONTEXT_MAX_CHARACTERS.toLocaleString()} characters. Move the command into a smaller branch or remove references.`,
    )
  }
}

/** Resolve the ancestor path, parent branch, and stable internal-link references. */
export function resolveAgentContext(
  doc: ProseMirrorNode,
  invocationNodeId: string,
): ResolvedAgentContext {
  const { byId } = outlineEntries(doc)
  const invocation = byId.get(invocationNodeId)
  if (!invocation) throw new Error('Could not locate the skill invocation bullet.')

  const local = localEntries(invocation)
  const groups = referencedGroups(invocation, byId, local.entries)
  const referencedNodeIds = groups.flatMap((group) => group.nodeIds)
  const serialized = serializeContext(local.entries, groups)
  const nodeCount = local.entries.length + referencedNodeIds.length
  const characterCount = serialized.length

  assertWithinContextBudget(nodeCount, characterCount)

  return {
    invocationNodeId,
    localRootNodeId: local.root?.id ?? null,
    localNodeIds: local.entries.map((entry) => entry.id),
    referencedNodeIds,
    referencedGroups: groups,
    serialized,
    lines: serialized ? [serialized] : [],
    nodeCount,
    characterCount,
  }
}

function snapshotNode(
  entry: OutlineEntry,
  included: ReadonlySet<string>,
  documentOrder: ReadonlyMap<OutlineEntry, number>,
): ExtensionSkillContextNode {
  const children = entry.children
    .filter((child) => included.has(child.id))
    .map((child) => snapshotNode(child, included, documentOrder))
  return {
    id: entry.id,
    text: entry.text,
    documentOrder: documentOrder.get(entry) ?? 0,
    ...(children.length ? { children } : {}),
  }
}

/**
 * Build the single immutable tree supplied to a generic extension executor.
 * The application, rather than extension code, owns outline scope and link resolution.
 */
export function resolveExtensionSkillContext(
  doc: ProseMirrorNode,
  invocationNodeId: string,
  prompt: string,
): ResolvedExtensionSkillContext {
  const { ordered, byId } = outlineEntries(doc)
  const invocation = byId.get(invocationNodeId)
  if (!invocation) throw new Error('Could not locate the skill invocation bullet.')
  const documentOrder = new Map(ordered.map((entry, index) => [entry, index]))

  const local = localEntries(invocation)
  const groups = referencedGroups(invocation, byId, local.entries)
  const localIds = new Set(local.entries.map((entry) => entry.id))
  const referencedIds = new Set(groups.flatMap((group) => group.nodeIds))
  const included = new Set([...localIds, ...referencedIds])
  const roots: ExtensionSkillContextNode[] = []
  if (local.root) roots.push(snapshotNode(local.root, included, documentOrder))
  for (const group of groups) {
    const root = byId.get(group.targetId)
    if (root && included.has(root.id)) roots.push(snapshotNode(root, included, documentOrder))
  }

  const snapshot = extensionSkillContextSnapshotSchema.parse({
    prompt,
    invocation: {
      id: invocation.id,
      text: invocation.node.firstChild?.textContent ?? '',
      ...(invocation.parent ? { parentId: invocation.parent.id } : {}),
      documentOrder: documentOrder.get(invocation) ?? 0,
    },
    roots,
    provenance: {
      ancestorPathIds: local.entries.filter((entry) => {
        let current = invocation.parent
        while (current) {
          if (current === entry) return true
          current = current.parent
        }
        return false
      }).map((entry) => entry.id),
      ...(invocation.parent ? { localParentId: invocation.parent.id } : {}),
      ...(local.root ? { localBranchRootId: local.root.id } : {}),
      explicitLinkedRootIds: groups.map((group) => group.targetId),
    },
  })
  const admittedReferenceIds = [...local.entries, ...groups.flatMap((group) => (
    group.nodeIds.map((id) => byId.get(id)).filter((entry): entry is OutlineEntry => Boolean(entry))
  ))]
    .sort((left, right) => (documentOrder.get(left) ?? 0) - (documentOrder.get(right) ?? 0))
    .map((entry) => entry.id)
  return {
    snapshot,
    localNodeIds: [...localIds],
    referencedNodeIds: [...referencedIds],
    admittedReferenceIds,
  }
}

export interface ResolvedFollowUpContext {
  context: ResolvedAgentContext
  /** The bullets under the invocation, one line each, marking agent and user bullets. */
  invocationOutline: string[]
}

/**
 * Context for a conversation reply: the same scope as a first run, plus the
 * invocation's current subtree, which a first run excludes. Both share one budget.
 */
export function resolveFollowUpContext(
  doc: ProseMirrorNode,
  invocationNodeId: string,
): ResolvedFollowUpContext {
  const context = resolveAgentContext(doc, invocationNodeId)
  const invocation = outlineEntries(doc).byId.get(invocationNodeId)!
  const entries = subtree(invocation).slice(1)
  const invocationOutline = entries.map((entry) => (
    `${'  '.repeat(Math.max(0, entry.depth - invocation.depth - 1))}- [${entry.node.attrs.nodeType === 'ai' ? 'agent' : 'user'}] ${entry.text || '(empty)'}`
  ))
  assertWithinContextBudget(
    context.nodeCount + entries.length,
    context.characterCount + invocationOutline.reduce((total, line) => total + line.length + 1, 0),
  )
  return { context, invocationOutline }
}
