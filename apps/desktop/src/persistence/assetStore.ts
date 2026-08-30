import { invoke } from '@tauri-apps/api/core'
import {
  validateGeneratedImage,
  type GeneratedImageData,
  type GeneratedImageReference,
} from '../editor/generatedImage'

export interface AssetMetadata {
  assetId: string
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp'
  byteSize: number
}

export interface AssetContent extends AssetMetadata {
  bytes: number[]
}

export class NativeAssetRepository {
  async ingestGeneratedImage(value: unknown): Promise<GeneratedImageReference> {
    const image = validateGeneratedImage(value)
    if (!image) throw new Error('Invalid generated image data.')
    const metadata = await invoke<AssetMetadata>('asset_ingest_data_url', { dataUrl: image.src })
    return { assetId: metadata.assetId, alt: image.alt }
  }

  async read(assetId: string): Promise<AssetContent> {
    if (!/^[a-f0-9]{64}$/.test(assetId)) throw new Error('Invalid asset identifier.')
    return invoke('asset_read', { assetId })
  }

  validateInput(value: GeneratedImageData): GeneratedImageData {
    const validated = validateGeneratedImage(value)
    if (!validated) throw new Error('Invalid generated image data.')
    return validated
  }
}
