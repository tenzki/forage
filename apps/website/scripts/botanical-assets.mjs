import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

export const website = fileURLToPath(new URL('../', import.meta.url))
export const originals = resolve(website, '../../docs/branding-assets')
export const vectors = resolve(website, 'src/assets/botanicals')
export const assets = [
  { name: 'lavender-square-dot-01', widths: [400, 600, 1100], quality: 90 },
  { name: 'elderflower-square-dot-01', widths: [164, 328, 560], quality: 90 },
  { name: 'footer-border-desktop-01', widths: [1440, 1944], quality: 88 },
  { name: 'footer-border-mobile-01', widths: [390, 780], quality: 88 },
]
