import { afterEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { BulletAttributes } from './extensions'
import {
  GeneratedImage,
  GeneratedImageItem,
  OutlineBulletList,
  validateGeneratedImage,
} from './generatedImage'

const WEBP = `data:image/webp;base64,${btoa('RIFF\u0004\u0000\u0000\u0000WEBP')}`
const editors: Editor[] = []

function makeEditor(content: object): Editor {
  const editor = new Editor({
    element: document.createElement('div'),
    extensions: [
      StarterKit.configure({ bulletList: false }),
      OutlineBulletList,
      GeneratedImageItem,
      GeneratedImage,
      BulletAttributes,
    ],
    content,
  })
  editors.push(editor)
  return editor
}

afterEach(() => editors.splice(0).forEach((editor) => editor.destroy()))

describe('generated image nodes', () => {
  it('accepts bounded raster data and rejects active or remote sources', () => {
    expect(validateGeneratedImage({ src: WEBP, alt: 'A small test image' })).toEqual({ src: WEBP, alt: 'A small test image' })
    expect(validateGeneratedImage({ src: 'https://example.com/image.webp', alt: 'Remote' })).toBeNull()
    expect(validateGeneratedImage({ src: 'data:image/svg+xml;base64,PHN2Zz4=', alt: 'SVG' })).toBeNull()
  })

  it('persists only a content-addressed asset reference and survives JSON reload', () => {
    const assetId = 'a'.repeat(64)
    const content = {
      type: 'doc',
      content: [{
        type: 'bulletList',
        content: [{
          type: 'generatedImageItem',
          content: [{ type: 'generatedImage', attrs: { assetId, alt: 'Generated visual' } }],
        }],
      }],
    }
    const first = makeEditor(content)
    const reloaded = makeEditor(first.getJSON())
    const image = reloaded.view.dom.querySelector<HTMLImageElement>('img[data-ai-generated-image]')

    expect(image?.hasAttribute('src')).toBe(false)
    expect(image?.dataset.assetId).toBe(assetId)
    expect(image?.alt).toBe('Generated visual')
    expect(image?.closest('li')?.getAttribute('data-node-type')).toBe('image')
    expect(image?.closest('li')?.querySelector('p')).toBeNull()
    expect(reloaded.getJSON()).toEqual(first.getJSON())
    expect(JSON.stringify(reloaded.getJSON())).not.toContain('data:image')
  })
})
