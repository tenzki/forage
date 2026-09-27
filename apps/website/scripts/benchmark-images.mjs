import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { platform, arch, cpus } from 'node:os'
import { performance } from 'node:perf_hooks'
import { gzipSync, brotliCompressSync, constants } from 'node:zlib'
import sharp from 'sharp'
import { assets, originals, vectors, website } from './botanical-assets.mjs'

// CPU proxy only: libvips/librsvg rendering is not browser rendering or LCP.
// Render at the target density so SVG does not incur a full-size raster first.
sharp.cache(false)
sharp.concurrency(1)
const iterations = 20
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const measure = async operation => {
  for (let i = 0; i < 3; i++) await operation()
  const timings = []
  for (let i = 0; i < iterations; i++) {
    const start = performance.now()
    await operation()
    timings.push(performance.now() - start)
  }
  return median(timings)
}
const kib = bytes => (bytes / 1024).toFixed(1)
const results = []
for (const asset of assets) {
  const png = await readFile(join(originals, `${asset.name}.png`))
  const svg = await readFile(join(vectors, `${asset.name}.svg`))
  const markup = svg.toString()
  assert.doesNotMatch(markup, /<image\b|data:image|<script\b/)
  assert.match(markup, /viewBox=/)
  const { width: originalWidth } = await sharp(png).metadata()
  const result = {
    name: asset.name,
    squares: [...markup.matchAll(/<rect\b/g)].length,
    svgBytes: svg.length,
    gzipBytes: gzipSync(svg, { level: 6 }).length,
    brotliBytes: brotliCompressSync(svg, { params: { [constants.BROTLI_PARAM_QUALITY]: 6 } }).length,
    variants: [],
  }
  for (const width of asset.widths) {
    // Match the previous Astro WebP width/quality settings from the same PNG.
    const webp = await sharp(png).resize({ width }).webp({ quality: asset.quality }).toBuffer()
    const renderSvg = () => sharp(svg, { density: 72 * width / originalWidth }).resize({ width }).flatten({ background: '#F5F2E8' }).removeAlpha().raw().toBuffer()
    const renderWebp = () => sharp(webp).flatten({ background: '#F5F2E8' }).removeAlpha().raw().toBuffer()
    const svgMs = await measure(renderSvg)
    const webpMs = await measure(renderWebp)
    result.variants.push({ width, webpBytes: webp.length, svgMs, webpMs })
  }
  results.push(result)
  console.log(`${asset.name}: ${result.squares} squares, ${kib(result.brotliBytes)} KiB Brotli`)
}

// Explicit width selections, not a claim about browser srcset heuristics.
const scenarios = [
  { label: 'Mobile, 1×', selections: [[0, 400], [1, 164], [3, 390]] },
  { label: 'Mobile, 2×', selections: [[0, 1100], [1, 328], [3, 780]] },
  { label: 'Desktop, 1×', selections: [[0, 600], [1, 328], [2, 1440]] },
  { label: 'Desktop, 2×', selections: [[0, 1100], [1, 560], [2, 1944]] },
].map(({ label, selections }) => {
  const total = { label, webpBytes: 0, svgBytes: 0, gzipBytes: 0, brotliBytes: 0 }
  for (const [index, width] of selections) {
    const result = results[index]
    const variant = result.variants.find(variant => variant.width === width)
    total.webpBytes += variant.webpBytes
    for (const key of ['svgBytes', 'gzipBytes', 'brotliBytes']) total[key] += result[key]
  }
  return total
})
const report = {
  measuredAt: new Date().toISOString(),
  environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model, sharp: sharp.versions },
  iterations, results, scenarios,
}
const markdown = `# Botanical SVG performance experiment

Measured ${report.measuredAt} on ${report.environment.cpu} (${platform()} ${arch()}, Node ${process.version}, Sharp ${sharp.versions.sharp}).

All four botanical images are reconstructed from individual SVG rounded squares, with position, size and color estimated from the original marks. The original PNGs remain untouched. The site loads external, hashed SVG files through img/picture, preserving lazy loading and desktop/mobile footer art. SVGs are generated ahead of time; Python and Pillow are not needed for site builds.

## Transfer sizes

SVG compression uses gzip level 6 and Brotli quality 6. These are potential response sizes **only if the host enables SVG compression**. WebP sizes are the binary payloads at the previous Astro widths and quality settings. Headers, fonts, HTML and CSS are excluded.

| Asset | Squares | SVG raw KiB | gzip KiB | Brotli KiB | Previous WebP KiB (width → size) |
| --- | ---: | ---: | ---: | ---: | --- |
${results.map(result => `| ${result.name} | ${result.squares} | ${kib(result.svgBytes)} | ${kib(result.gzipBytes)} | ${kib(result.brotliBytes)} | ${result.variants.map(v => `${v.width} → ${kib(v.webpBytes)}`).join(', ')} |`).join('\n')}

## Whole-page illustration payload

Each scenario counts lavender, elderflower and **one** footer image after scrolling through the page. Footer and elderflower remain lazy loaded. Mobile assumes a 390px viewport and 342px hero slot; desktop assumes a 1440px viewport and 548px hero slot. Width selections are the first available candidate meeting the target pixel width, capped at the largest existing WebP. Actual browser selection can vary.

| Scenario | WebP KiB | SVG raw KiB | SVG gzip KiB | SVG Brotli KiB | Brotli / WebP |
| --- | ---: | ---: | ---: | ---: | ---: |
${scenarios.map(s => `| ${s.label} | ${kib(s.webpBytes)} | ${kib(s.svgBytes)} | ${kib(s.gzipBytes)} | ${kib(s.brotliBytes)} | ${(s.brotliBytes / s.webpBytes).toFixed(1)}× |`).join('\n')}

## Local decode / rasterization CPU proxy

Median of ${iterations} sequential runs after 3 warmups, file bytes already in memory, Sharp cache disabled and one worker thread. SVG uses target density before rasterizing; WebP is decoded at its native delivered dimensions. Both produce uncompressed RGB pixels. These numbers measure libvips/librsvg, **not browser paint time, frame rate, Lighthouse or LCP**. Browser testing has not been performed.

| Asset | Width px | WebP decode ms | SVG rasterize ms | Ratio |
| --- | ---: | ---: | ---: | ---: |
${results.flatMap(r => r.variants.map(v => `| ${r.name} | ${v.width} | ${v.webpMs.toFixed(2)} | ${v.svgMs.toFixed(2)} | ${(v.svgMs / v.webpMs).toFixed(1)}× |`)).join('\n')}

## Reproduce

Run \`pnpm --filter @forage/website benchmark:images\`. This recreates WebP baselines from the original PNGs and rewrites this report and its JSON data. Run \`pnpm --filter @forage/website vectorize:images\` to regenerate optimized SVGs (requires Python with Pillow 12.1.1).

The SVG experiment is active as requested. Judge its shipping suitability using both appearance and the transfer/CPU results; vector format alone does not imply better performance. For a browser follow-up, compare cold and warm loads at the same mobile/desktop viewport, device scale, CPU/network throttle and compression settings, including a scroll to the footer.
`
await mkdir(join(website, 'reports'), { recursive: true })
await writeFile(join(website, 'reports/image-performance.json'), JSON.stringify(report, null, 2) + '\n')
await writeFile(join(website, 'reports/image-performance.md'), markdown)
console.log('Wrote reports/image-performance.md and .json')
