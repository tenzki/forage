import { describe, expect, it, vi } from 'vitest'
import { resolveAssetImages } from './assetImages'

describe('asset image rendering', () => {
  it('resolves cached content to a local blob URL without changing the document reference', async () => {
    const root = document.createElement('div')
    root.innerHTML = `<img data-ai-generated-image data-asset-id="${'a'.repeat(64)}" data-asset-state="loading" alt="Generated">`
    const createUrl = vi.fn(() => 'blob:local-asset')
    await resolveAssetImages(root, {
      read: async () => ({ assetId: 'a'.repeat(64), mediaType: 'image/png', byteSize: 8, bytes: [137, 80, 78, 71, 13, 10, 26, 10] }),
    }, createUrl)

    const image = root.querySelector('img')!
    expect(image.getAttribute('src')).toBe('blob:local-asset')
    expect(image.dataset.assetState).toBe('available')
    expect(createUrl).toHaveBeenCalledOnce()
  })

  it('marks missing offline content as recoverably unavailable', async () => {
    const root = document.createElement('div')
    root.innerHTML = `<img data-ai-generated-image data-asset-id="${'b'.repeat(64)}" data-asset-state="loading" alt="Missing">`
    await resolveAssetImages(root, { read: async () => { throw new Error('unavailable') } })

    const image = root.querySelector('img')!
    expect(image.hasAttribute('src')).toBe(false)
    expect(image.dataset.assetState).toBe('unavailable')
    expect(image.title).toMatch(/unavailable offline/i)
  })
})
