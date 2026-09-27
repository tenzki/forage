import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

// Check the generated deliverable, including Astro's optimized asset URLs.
const dist = resolve('dist')
const html = await readFile(resolve(dist, 'index.html'), 'utf8')
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1])
assert.equal(new Set(ids).size, ids.length, 'HTML IDs must be unique')
assert.equal([...html.matchAll(/<h1\b/g)].length, 1, 'The page must have one main heading')
assert.match(html, /<html[^>]+lang="en"/)
assert.match(html, /name="description"/)
assert.match(html, /https:\/\/github\.com\/tenzki\/forage\/releases/)

const assets = new Set()
for (const [, url] of html.matchAll(/\b(?:href|src)="([^"]+)"/g)) {
  if (url.startsWith('#')) assert.ok(ids.includes(url.slice(1)), `Missing anchor: ${url}`)
  else if (url.startsWith('/') && !url.startsWith('//')) assets.add(url)
}
for (const [, srcset] of html.matchAll(/\bsrcset="([^"]+)"/g)) {
  for (const candidate of srcset.split(',')) {
    const url = candidate.trim().split(/\s+/)[0]
    if (url.startsWith('/') && !url.startsWith('//')) assets.add(url)
  }
}
for (const url of assets) {
  const path = resolve(dist, decodeURIComponent(url.split(/[?#]/)[0].slice(1)))
  assert.ok(path.startsWith(dist + sep), `Asset escapes output: ${url}`)
  assert.ok((await stat(path)).isFile(), `Missing asset: ${url}`)
}
console.log(`Static output checked: ${ids.length} unique anchors, ${assets.size} local assets, release links, metadata.`)
