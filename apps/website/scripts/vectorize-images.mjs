import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { optimize } from 'svgo'
import { assets, originals, vectors, website } from './botanical-assets.mjs'

// Install once with: python3 -m pip install Pillow==12.1.1
// Fit each source mark with a simple rounded square; retain rect elements.
const python = process.env.PYTHON || 'python3'
const temporary = await mkdtemp(join(tmpdir(), 'forage-vectorize-'))
await mkdir(vectors, { recursive: true })
try {
  for (const { name } of assets) {
    const input = join(originals, `${name}.png`)
    const output = join(temporary, `${name}.svg`)
    const result = spawnSync(python, [join(website, 'scripts/fit-botanical-squares.py'), input, output,
      ...(name.startsWith('footer-') ? ['--fine'] : [])], { encoding: 'utf8' })
    assert.equal(result.status, 0, `Square fitting failed: ${result.error || result.stderr || result.signal}`)
    const raw = await readFile(output, 'utf8')
    const { data } = optimize(raw, {
      multipass: true, floatPrecision: 1,
      plugins: [{ name: 'preset-default', params: { overrides: { convertShapeToPath: false } } }],
    })
    assert.match(data, /viewBox=/)
    assert.doesNotMatch(data, /<path\b|<pattern\b|<image\b|data:image|<script\b/)
    await writeFile(join(vectors, `${name}.svg`), data)
    console.log(`${name}: ${[...data.matchAll(/<rect\b/g)].length} squares, ${(Buffer.byteLength(data) / 1024).toFixed(0)} KiB`)
  }
} finally {
  await rm(temporary, { recursive: true, force: true })
}
