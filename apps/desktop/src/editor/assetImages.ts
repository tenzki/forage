import { NativeAssetRepository, type AssetContent } from '../persistence/assetStore'

export interface AssetReader {
  read: (assetId: string) => Promise<AssetContent>
}

export async function resolveAssetImages(
  root: ParentNode,
  repository: AssetReader = new NativeAssetRepository(),
  createObjectUrl: (blob: Blob) => string = URL.createObjectURL.bind(URL),
): Promise<string[]> {
  const urls: string[] = []
  const images = [...root.querySelectorAll<HTMLImageElement>(
    'img[data-ai-generated-image][data-asset-state="loading"]',
  )]
  await Promise.all(images.map(async (image) => {
    const assetId = image.dataset.assetId ?? ''
    try {
      const content = await repository.read(assetId)
      const url = createObjectUrl(new Blob([new Uint8Array(content.bytes)], { type: content.mediaType }))
      image.src = url
      image.dataset.assetState = 'available'
      image.removeAttribute('title')
      urls.push(url)
    } catch {
      image.removeAttribute('src')
      image.dataset.assetState = 'unavailable'
      image.title = 'Image unavailable offline. Reconnect to the server to download it.'
    }
  }))
  return urls
}
