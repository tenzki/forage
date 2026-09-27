import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { brotliCompressSync, constants } from 'node:zlib'
import sharp from 'sharp'
import { optimize } from 'svgo'
import { assets, originals, vectors, website } from './botanical-assets.mjs'

const output = join(website, 'reports/square-botanicals')
const temporary = await mkdtemp(join(tmpdir(), 'forage-squares-'))
await mkdir(output, { recursive: true })
const results = []
sharp.cache(false)
sharp.concurrency(1)
try {
  for (const asset of assets) {
    const fine = asset.name.startsWith('footer-')
    const rawPath = join(temporary, `${asset.name}.svg`)
    const process = spawnSync(globalThis.process.env.PYTHON || 'python3', [
      join(website, 'scripts/fit-botanical-squares.py'), join(originals, `${asset.name}.png`), rawPath,
      ...(fine ? ['--fine'] : []),
    ], { encoding: 'utf8' })
    assert.equal(process.status, 0, process.error?.message || process.stderr)
    const svg = Buffer.from(optimize(await readFile(rawPath, 'utf8'), {
      multipass: true, floatPrecision: 1,
      plugins: [{ name: 'preset-default', params: { overrides: { convertShapeToPath: false } } }],
    }).data)
    const markup = svg.toString()
    assert.doesNotMatch(markup, /<path\b|<pattern\b|<image\b|data:image|<script\b/)
    const rects = [...markup.matchAll(/<rect\b[^>]*>/g)].map(match => match[0])
    assert.ok(rects.length > 100)
    for (const rect of rects) {
      const width = rect.match(/\bwidth="([^"]+)"/)[1]
      const height = rect.match(/\bheight="([^"]+)"/)[1]
      assert.equal(width, height, 'Every foreground shape must be a square')
    }
    await writeFile(join(output, `${asset.name}.svg`), svg)
    const original = await readFile(join(originals, `${asset.name}.png`))
    const { width, height } = await sharp(original).metadata()
    const renderWidth = asset.name.startsWith('lavender') ? 548 : asset.name.startsWith('elderflower') ? 280 : fine && width > height ? 1440 : 390
    const render = () => sharp(svg, { density: 72 * renderWidth / width }).resize(renderWidth).raw().toBuffer()
    await render()
    const timings = []
    for (let i = 0; i < 5; i++) {
      const start = performance.now()
      await render()
      timings.push(performance.now() - start)
    }
    const previous = await readFile(join(vectors, `${asset.name}.svg`))
    const brotli = input => brotliCompressSync(input, { params: { [constants.BROTLI_PARAM_QUALITY]: 6 } }).length
    results.push({ name: asset.name, squares: rects.length, bytes: svg.length, brotliBytes: brotli(svg),
      previousBrotliBytes: brotli(previous), renderWidth, renderMs: timings.sort((a,b) => a-b)[2] })

    const previewWidth = width > height ? 972 : 560
    const reference = await sharp(original).resize(previewWidth).png().toBuffer()
    const candidate = await sharp(svg, { density: 72 * previewWidth / width }).resize(previewWidth).png().toBuffer()
    await writeFile(join(output, `${asset.name}.png`), candidate)
    const { height: previewHeight } = await sharp(reference).metadata()
    const label = (panelWidth, left, right) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${panelWidth*2}" height="40"><rect width="100%" height="100%" fill="#e9e4d6"/><g font-family="monospace" font-size="17" fill="#203d32"><text x="16" y="27">${left}</text><text x="${panelWidth+16}" y="27">${right}</text></g></svg>`)
    await sharp({ create: { width: previewWidth * 2, height: previewHeight + 40, channels: 3, background: '#F5F2E8' } })
      .composite([{ input: label(previewWidth, 'Original artwork', 'Individual rounded squares'), left: 0, top: 0 },
        { input: reference, left: 0, top: 40 }, { input: candidate, left: previewWidth, top: 40 }])
      .png().toFile(join(output, `${asset.name}-comparison.png`))
    if (asset.name.startsWith('elderflower')) {
      const crop = { left: 680, top: 680, width: 320, height: 260 }
      const left = await sharp(original).extract(crop).resize(640,520,{kernel:'nearest'}).png().toBuffer()
      const right = await sharp(svg).extract(crop).resize(640,520,{kernel:'nearest'}).png().toBuffer()
      await sharp({ create: { width:1280,height:560,channels:3,background:'#F5F2E8' } })
        .composite([{input:label(640,'Original marks','Simple SVG squares'),left:0,top:0},{input:left,left:0,top:40},{input:right,left:640,top:40}])
        .png().toFile(join(output,'elderflower-detail.png'))
    }
    console.log(`${asset.name}: ${rects.length} squares, ${brotli(svg)} bytes Brotli`)
  }
} finally {
  await rm(temporary, { recursive: true, force: true })
}
await writeFile(join(output,'measurements.json'),JSON.stringify({measuredAt:new Date().toISOString(),results},null,2)+'\n')
await writeFile(join(output,'README.md'),`# Botanical illustrations made of individual squares

Each original mark is approximated with an individual rounded square. Position, area and color come from the source artwork. All foreground shapes are SVG rect elements with equal width and height; there are no traced contours, leaf silhouettes, fill patterns or embedded images. Some detected regions are split or combined, so this does not imply one-to-one recovery of every original mark.

${assets.map(a=>`- [${a.name}: comparison](${a.name}-comparison.png) · [SVG](${a.name}.svg)`).join('\n')}
- [Enlarged elderflower square detail](elderflower-detail.png)

The reconstruction keeps the source composition. Small differences in spacing, size and color are expected. Each image uses a sampled 96-color palette on a transparent background; shading inside individual marks is simplified. Comparison sheets use a paper-colored canvas for reference. Fine footer marks use a smaller detection window.

| Image | Squares | Raw KiB | Brotli KiB | Previous traced SVG Brotli KiB | Local render ms (width) |
| --- | ---: | ---: | ---: | ---: | ---: |
${results.map(r=>`| ${r.name} | ${r.squares} | ${(r.bytes/1024).toFixed(1)} | ${(r.brotliBytes/1024).toFixed(1)} | ${(r.previousBrotliBytes/1024).toFixed(1)} | ${r.renderMs.toFixed(2)} (${r.renderWidth}px) |`).join('\n')}

Brotli quality 6; compression must be enabled by the host. Rendering is a local Sharp/librsvg proxy (five samples after one warmup, cache off, one worker), not browser/LCP timing. Previews compare directly rasterized SVGs with resized original PNGs. No browser was used.

Run \`pnpm --filter @forage/website prototype:squares\` to regenerate, using Python with Pillow 12.1.1. The prototype command writes only this report directory. The previous SVG column measures the site assets present when the command ran.
`)
