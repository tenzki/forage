import type { OutlineState } from './reducer'

export interface CheckpointMetadata {
  id: string
  outlineId: string
  documentVersion: number
  schemaEpoch: number
  localSequence: number
  serverRevision: number
}

export interface OutlineCheckpoint extends CheckpointMetadata {
  state: OutlineState
  integrityHash: string
  createdAt: string
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    )
  }
  return value
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

export async function sha256Hex(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function checkpointIntegrityInput(
  checkpoint: Pick<OutlineCheckpoint, keyof CheckpointMetadata | 'state'>,
): string {
  return canonicalJson({
    id: checkpoint.id,
    outlineId: checkpoint.outlineId,
    documentVersion: checkpoint.documentVersion,
    schemaEpoch: checkpoint.schemaEpoch,
    localSequence: checkpoint.localSequence,
    serverRevision: checkpoint.serverRevision,
    state: checkpoint.state,
  })
}

export async function createCheckpoint(
  state: OutlineState,
  metadata: CheckpointMetadata,
): Promise<OutlineCheckpoint> {
  const stableState = structuredClone(state)
  return {
    ...metadata,
    state: stableState,
    integrityHash: await sha256Hex(checkpointIntegrityInput({ ...metadata, state: stableState })),
    createdAt: new Date().toISOString(),
  }
}

export async function verifyCheckpoint(checkpoint: OutlineCheckpoint): Promise<boolean> {
  const actual = await sha256Hex(checkpointIntegrityInput(checkpoint))
  return actual === checkpoint.integrityHash
}

export async function selectCompatibleCheckpoint(
  checkpoints: readonly OutlineCheckpoint[],
  compatibility: Pick<CheckpointMetadata, 'documentVersion' | 'schemaEpoch'>,
): Promise<OutlineCheckpoint | null> {
  const candidates = checkpoints
    .filter((checkpoint) => (
      checkpoint.documentVersion === compatibility.documentVersion
      && checkpoint.schemaEpoch === compatibility.schemaEpoch
    ))
    .sort((left, right) => right.localSequence - left.localSequence)
  for (const checkpoint of candidates) {
    if (await verifyCheckpoint(checkpoint)) return checkpoint
  }
  return null
}
