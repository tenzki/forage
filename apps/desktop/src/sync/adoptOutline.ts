import { reduceOutlineEvent, type OutlineState } from '@forage/domain'
import type { ReplayInput, StoredCheckpoint } from '../persistence/eventStore'

export interface AdoptionProgress {
  phase: 'replaying' | 'seeding' | 'settling'
  assetCount: number
}

export interface AdoptionRepository {
  loadReplayInput(outlineId: string): Promise<ReplayInput | null>
  seedOutline(state: OutlineState): Promise<{ outlineId: string; revision: number; integrityHash: string }>
  markSeeded(outlineId: string, checkpoint: StoredCheckpoint): Promise<void>
}

interface DocumentNodeJson {
  attrs?: Record<string, unknown>
  content?: DocumentNodeJson[]
}

function referencedAssetCount(state: OutlineState): number {
  const found = new Set<string>()
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return }
    if (!value || typeof value !== 'object') return
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'assetId' && typeof entry === 'string') found.add(entry)
      else visit(entry)
    }
  }
  visit(state as unknown as DocumentNodeJson)
  return found.size
}

/**
 * Makes this device's local outline the content of a freshly claimed server outline.
 *
 * The outbox is settled only after the server has accepted the seed, so a failure at any
 * earlier point leaves the device in local mode with its pending events intact.
 */
export async function adoptLocalOutline(
  repository: AdoptionRepository,
  outlineId: string,
  onProgress?: (progress: AdoptionProgress) => void,
): Promise<{ revision: number; integrityHash: string; assetCount: number }> {
  onProgress?.({ phase: 'replaying', assetCount: 0 })
  const replay = await repository.loadReplayInput(outlineId)
  if (!replay) throw new Error('This device has no local outline to copy.')
  let state = replay.state
  for (const event of replay.events) state = reduceOutlineEvent(state, event)
  const assetCount = referencedAssetCount(state)

  onProgress?.({ phase: 'seeding', assetCount })
  const seeded = await repository.seedOutline(state)

  onProgress?.({ phase: 'settling', assetCount })
  await repository.markSeeded(outlineId, {
    id: `checkpoint_${crypto.randomUUID()}`,
    outlineId,
    documentVersion: replay.checkpoint.documentVersion,
    schemaEpoch: state.schemaEpoch,
    // The native command replaces this with the highest local sequence it actually settled.
    localSequence: replay.checkpoint.localSequence,
    serverRevision: seeded.revision,
    stateJson: JSON.stringify(state),
    integrityHash: seeded.integrityHash,
    createdAt: new Date().toISOString(),
  })
  return { revision: seeded.revision, integrityHash: seeded.integrityHash, assetCount }
}
