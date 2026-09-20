import type {
  ExtensionJsonObject,
  ExtensionSkillContextNode,
  ExtensionSkillContextSnapshot,
  ExtensionSkillPreparedPlan,
} from '@forage/extension-api'
import type { SystemOneConfiguration } from './domain.js'

export interface PreparedCandidate {
  id: string
  label: string
  text: string
  documentOrder: number
  evidence: ReadonlyArray<{ id: string; text: string; documentOrder: number }>
}

export interface PreparedSharedEvidence {
  id: string
  text: string
  documentOrder: number
  provenance: 'ancestor' | 'explicit-link'
}

export interface PreparedSystemOneData {
  version: 1
  candidateScope: SystemOneConfiguration['candidateScope']
  candidates: PreparedCandidate[]
  sharedEvidence: PreparedSharedEvidence[]
}

export function prepareSystemOneInput(
  configuration: SystemOneConfiguration,
  context: ExtensionSkillContextSnapshot,
): ExtensionSkillPreparedPlan {
  const index = indexContext(context.roots)
  const parentId = context.provenance.localParentId
  const parent = parentId ? index.byId.get(parentId) : undefined
  if (!parent) throw new Error('System One requires an invocation inside a parent branch.')

  const candidateNodes = configuration.candidateScope === 'siblings'
    ? [...(parent.children ?? [])].filter(isTextNode)
    : descendants(parent).filter(isTextNode)
  candidateNodes.sort((left, right) => left.documentOrder - right.documentOrder)
  if (candidateNodes.length === 0) throw new Error('System One found no text candidates in the selected scope.')
  if (configuration.kind === 'choice-comparison' && candidateNodes.length < 2) {
    throw new Error('Choice comparison requires at least two candidates in the selected scope.')
  }

  const candidates = candidateNodes.map((node): PreparedCandidate => ({
    id: node.id,
    label: node.text.trim() || 'Untitled note',
    text: node.text,
    documentOrder: node.documentOrder,
    evidence: configuration.candidateScope === 'siblings'
      ? descendants(node).filter(isTextNode).sort(byDocumentOrder).map((entry) => ({
        id: entry.id,
        text: entry.text,
        documentOrder: entry.documentOrder,
      }))
      : [],
  }))
  const candidateIds = new Set(candidates.map((candidate) => candidate.id))
  const candidateEvidenceIds = new Set(candidates.flatMap((candidate) => candidate.evidence.map((entry) => entry.id)))
  const sharedEvidence = collectSharedEvidence(context, index.byId, candidateIds, candidateEvidenceIds)
  const annotations = [
    ...candidates.map((candidate) => ({
      nodeId: candidate.id,
      kind: 'selected' as const,
      label: configuration.candidateScope === 'siblings' ? 'System One candidate (subtree evidence)' : 'System One candidate',
    })),
    ...candidates.flatMap((candidate) => candidate.evidence.map((entry) => ({
      nodeId: entry.id,
      kind: 'information' as const,
      label: `Evidence for ${candidate.label}`.slice(0, 300),
    }))),
    ...sharedEvidence.map((entry) => ({
      nodeId: entry.id,
      kind: 'shared' as const,
      label: entry.provenance === 'ancestor' ? 'Shared ancestor evidence' : 'Shared linked evidence',
    })),
  ]

  return {
    selectedNodeIds: candidates.map((candidate) => candidate.id),
    requestedReferenceIds: candidates.map((candidate) => candidate.id),
    annotations,
    data: toJsonObject({
      version: 1,
      candidateScope: configuration.candidateScope,
      candidates,
      sharedEvidence,
    }),
  }
}

export function requirePreparedSystemOneData(value: ExtensionJsonObject): PreparedSystemOneData {
  if (value.version !== 1 || (value.candidateScope !== 'siblings' && value.candidateScope !== 'descendants')) {
    throw new Error('System One prepared plan has an unsupported shape.')
  }
  if (!Array.isArray(value.candidates) || value.candidates.length < 1 || value.candidates.length > 100) {
    throw new Error('System One prepared plan has invalid candidates.')
  }
  const candidates = value.candidates.map((candidate, index) => parseCandidate(candidate, index))
  if (new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length) {
    throw new Error('System One prepared plan contains duplicate candidate IDs.')
  }
  if (!Array.isArray(value.sharedEvidence) || value.sharedEvidence.length > 100) {
    throw new Error('System One prepared plan has invalid shared evidence.')
  }
  const sharedEvidence = value.sharedEvidence.map((entry, index) => parseSharedEvidence(entry, index))
  return {
    version: 1,
    candidateScope: value.candidateScope,
    candidates,
    sharedEvidence,
  }
}

function indexContext(roots: ReadonlyArray<ExtensionSkillContextNode>): {
  byId: Map<string, ExtensionSkillContextNode>
} {
  const byId = new Map<string, ExtensionSkillContextNode>()
  const visit = (nodes: ReadonlyArray<ExtensionSkillContextNode>) => nodes.forEach((node) => {
    byId.set(node.id, node)
    visit(node.children ?? [])
  })
  visit(roots)
  return { byId }
}

function collectSharedEvidence(
  context: ExtensionSkillContextSnapshot,
  byId: ReadonlyMap<string, ExtensionSkillContextNode>,
  candidateIds: ReadonlySet<string>,
  candidateEvidenceIds: ReadonlySet<string>,
): PreparedSharedEvidence[] {
  const values = new Map<string, PreparedSharedEvidence>()
  const add = (node: ExtensionSkillContextNode, provenance: PreparedSharedEvidence['provenance']) => {
    if (!node.text.trim() || candidateIds.has(node.id) || candidateEvidenceIds.has(node.id) || values.has(node.id)) return
    values.set(node.id, { id: node.id, text: node.text, documentOrder: node.documentOrder, provenance })
  }
  for (const id of context.provenance.ancestorPathIds) {
    const node = byId.get(id)
    if (node) add(node, 'ancestor')
  }
  for (const id of context.provenance.explicitLinkedRootIds) {
    const root = byId.get(id)
    if (!root) continue
    add(root, 'explicit-link')
    descendants(root).forEach((node) => add(node, 'explicit-link'))
  }
  return [...values.values()].sort(byDocumentOrder)
}

function descendants(node: ExtensionSkillContextNode): ExtensionSkillContextNode[] {
  return (node.children ?? []).flatMap((child) => [child, ...descendants(child)])
}

function isTextNode(node: ExtensionSkillContextNode): boolean {
  return node.text.trim().length > 0
}

function byDocumentOrder(
  left: { documentOrder: number },
  right: { documentOrder: number },
): number {
  return left.documentOrder - right.documentOrder
}

function parseCandidate(value: unknown, index: number): PreparedCandidate {
  if (!isObject(value) || !hasExactKeys(value, ['id', 'label', 'text', 'documentOrder', 'evidence'])
    || typeof value.id !== 'string' || !value.id
    || typeof value.label !== 'string' || !value.label || value.label.length > 20_000
    || typeof value.text !== 'string' || value.text.length > 20_000
    || !Number.isInteger(value.documentOrder) || (value.documentOrder as number) < 0
    || !Array.isArray(value.evidence) || value.evidence.length > 100) {
    throw new Error(`System One prepared candidate ${index} is invalid.`)
  }
  const evidence = value.evidence.map((entry, evidenceIndex) => {
    if (!isObject(entry) || !hasExactKeys(entry, ['id', 'text', 'documentOrder'])
      || typeof entry.id !== 'string' || !entry.id
      || typeof entry.text !== 'string' || entry.text.length > 20_000
      || !Number.isInteger(entry.documentOrder) || (entry.documentOrder as number) < 0) {
      throw new Error(`System One prepared candidate ${index} evidence ${evidenceIndex} is invalid.`)
    }
    return { id: entry.id, text: entry.text, documentOrder: entry.documentOrder as number }
  })
  return {
    id: value.id,
    label: value.label,
    text: value.text,
    documentOrder: value.documentOrder as number,
    evidence,
  }
}

function parseSharedEvidence(value: unknown, index: number): PreparedSharedEvidence {
  if (!isObject(value) || !hasExactKeys(value, ['id', 'text', 'documentOrder', 'provenance'])
    || typeof value.id !== 'string' || !value.id
    || typeof value.text !== 'string' || value.text.length > 20_000
    || !Number.isInteger(value.documentOrder) || (value.documentOrder as number) < 0
    || (value.provenance !== 'ancestor' && value.provenance !== 'explicit-link')) {
    throw new Error(`System One prepared shared evidence ${index} is invalid.`)
  }
  return {
    id: value.id,
    text: value.text,
    documentOrder: value.documentOrder as number,
    provenance: value.provenance,
  }
}

function toJsonObject(value: PreparedSystemOneData): ExtensionJsonObject {
  return JSON.parse(JSON.stringify(value)) as ExtensionJsonObject
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}
