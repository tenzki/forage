import { beforeEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { NativeAssetRepository } from './assetStore'

const WEBP = `data:image/webp;base64,${btoa('RIFF\u0004\u0000\u0000\u0000WEBP')}`

describe('native asset repository', () => {
  beforeEach(() => invoke.mockReset())

  it('ingests trusted generated raster data before returning a durable asset reference', async () => {
    invoke.mockResolvedValueOnce({ assetId: 'a'.repeat(64), mediaType: 'image/webp', byteSize: 12 })
    const reference = await new NativeAssetRepository().ingestGeneratedImage({ src: WEBP, alt: ' Generated ' })

    expect(reference).toEqual({ assetId: 'a'.repeat(64), alt: 'Generated' })
    expect(invoke).toHaveBeenCalledWith('asset_ingest_data_url', {
      dataUrl: WEBP,
    })
  })

  it('rejects invalid input before sending bytes across the native boundary', async () => {
    await expect(new NativeAssetRepository().ingestGeneratedImage({
      src: 'data:image/svg+xml;base64,PHN2Zz4=', alt: 'unsafe',
    })).rejects.toThrow(/invalid generated image/i)
    expect(invoke).not.toHaveBeenCalled()
  })
})
