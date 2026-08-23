import { Node, mergeAttributes } from '@tiptap/core'
import BulletList from '@tiptap/extension-bullet-list'

export const MAX_GENERATED_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_DATA_URL_CHARS = Math.ceil(MAX_GENERATED_IMAGE_BYTES / 3) * 4 + 32
const DATA_URL = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/

export interface GeneratedImageData {
  src: string
  alt: string
}

function decodedSize(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.floor(base64.length * 3 / 4) - padding
}

function hasExpectedSignature(mediaType: string, base64: string): boolean {
  let header: number[]
  try {
    header = [...atob(base64.slice(0, 24))].map((value) => value.charCodeAt(0))
  } catch {
    return false
  }
  if (mediaType === 'image/png') {
    return header.slice(0, 8).join(',') === '137,80,78,71,13,10,26,10'
  }
  if (mediaType === 'image/jpeg') {
    return header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff
  }
  return String.fromCharCode(...header.slice(0, 4)) === 'RIFF'
    && String.fromCharCode(...header.slice(8, 12)) === 'WEBP'
}

/** Accept only bounded raster data URLs produced by the trusted Pi bridge. */
export function validateGeneratedImage(value: unknown): GeneratedImageData | null {
  if (!value || typeof value !== 'object') return null
  const image = value as Partial<GeneratedImageData>
  if (typeof image.src !== 'string' || typeof image.alt !== 'string') return null
  const alt = image.alt.trim()
  if (image.src.length > MAX_DATA_URL_CHARS || !alt || alt.length > 500) return null
  const match = DATA_URL.exec(image.src)
  if (!match) return null
  const [, mediaType, base64] = match
  if (base64.length % 4 !== 0 || decodedSize(base64) <= 0 || decodedSize(base64) > MAX_GENERATED_IMAGE_BYTES) return null
  if (!hasExpectedSignature(mediaType, base64)) return null
  return { src: image.src, alt }
}

/** Bullet lists accept image items as peers of text list items. */
export const OutlineBulletList = BulletList.extend({
  content: '(listItem | generatedImageItem)+',
})

/** A true image-only outline item: no paragraph or text listItem wrapper. */
export const GeneratedImageItem = Node.create({
  name: 'generatedImageItem',
  priority: 110,
  content: 'generatedImage',
  defining: true,
  isolating: true,
  selectable: true,

  parseHTML() {
    return [{ tag: 'li[data-generated-image-item]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['li', mergeAttributes(HTMLAttributes, {
      'data-generated-image-item': 'true',
      'data-node-type': 'image',
    }), 0]
  },
})

export const GeneratedImage = Node.create({
  name: 'generatedImage',
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      src: { default: '' },
      alt: { default: '' },
    }
  },

  parseHTML() {
    return [{
      tag: 'img[data-ai-generated-image]',
      getAttrs: (element) => {
        if (!(element instanceof HTMLImageElement)) return false
        return validateGeneratedImage({ src: element.getAttribute('src'), alt: element.alt }) ?? false
      },
    }]
  },

  renderHTML({ HTMLAttributes }) {
    const image = validateGeneratedImage(HTMLAttributes)
    if (!image) return ['span', { 'data-invalid-ai-image': 'true' }, 'Invalid generated image']
    return ['img', mergeAttributes(image, {
      'data-ai-generated-image': 'true',
      contenteditable: 'false',
      draggable: 'false',
      loading: 'lazy',
      decoding: 'async',
    })]
  },
})
