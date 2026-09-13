import { describe, expect, it, vi } from 'vitest'
import { adoptLocalOutline, type AdoptionRepository } from './adoptOutline'

import type { OutlineState } from '@forage/domain'

function emptyState(): OutlineState {
  return { doc: { type: 'doc', content: [] }, trash: [], shortcuts: [], schemaEpoch: 1 }
}

function repositoryFixture(state: OutlineState = emptyState()): AdoptionRepository & {
  seedOutline: ReturnType<typeof vi.fn>
  markSeeded: ReturnType<typeof vi.fn>
} {
  return {
    loadReplayInput: vi.fn(async () => ({
      checkpoint: {
        id: 'c1', outlineId: 'outline_1', documentVersion: 1, schemaEpoch: 1,
        localSequence: 4, serverRevision: 0, stateJson: '{}', integrityHash: '', createdAt: '',
      },
      state,
      events: [],
    })),
    seedOutline: vi.fn(async () => ({ outlineId: 'outline_1', revision: 0, integrityHash: 'b'.repeat(64) })),
    markSeeded: vi.fn(async () => {}),
  } as never
}

describe('adoptLocalOutline', () => {
  it('seeds the replayed state and then settles the outbox', async () => {
    const repository = repositoryFixture()
    const result = await adoptLocalOutline(repository, 'outline_1')

    expect(result.integrityHash).toBe('b'.repeat(64))
    expect(repository.seedOutline).toHaveBeenCalledBefore(repository.markSeeded)
    expect(repository.markSeeded.mock.calls[0][1]).toMatchObject({
      serverRevision: 0, integrityHash: 'b'.repeat(64),
    })
  })

  it('does not settle the outbox when seeding fails', async () => {
    const repository = repositoryFixture()
    repository.seedOutline = vi.fn(async () => { throw new Error('conflict') })

    await expect(adoptLocalOutline(repository, 'outline_1')).rejects.toThrow('conflict')
    expect(repository.markSeeded).not.toHaveBeenCalled()
  })

  it('counts the assets the seed references', async () => {
    const withImage: OutlineState = {
      ...emptyState(),
      doc: {
        type: 'doc',
        content: [{ type: 'generatedImageItem', attrs: { assetId: 'a'.repeat(64), alt: 'x' } }],
      },
    }
    const repository = repositoryFixture(withImage)
    const progress: string[] = []

    const result = await adoptLocalOutline(repository, 'outline_1', (entry) => {
      progress.push(`${entry.phase}:${entry.assetCount}`)
    })

    expect(result.assetCount).toBe(1)
    expect(progress).toEqual(['replaying:0', 'seeding:1', 'settling:1'])
  })

  it('refuses to adopt when the device has no local outline', async () => {
    const repository = repositoryFixture()
    repository.loadReplayInput = vi.fn(async () => null)

    await expect(adoptLocalOutline(repository, 'outline_1')).rejects.toThrow(/no local outline/i)
  })
})
