// @vitest-environment node
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileSystemAssetStorage, verifyAssetBytes } from './assets'

const roots: string[] = []
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

describe('server asset storage', () => {
  it('verifies signatures and caller hashes before deterministic deduplicated storage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forage-server-assets-'))
    roots.push(root)
    const storage = new FileSystemAssetStorage(root)
    const verified = await verifyAssetBytes(png, 'image/png')
    const first = await storage.putVerified(verified.assetId, png)
    const second = await storage.putVerified(verified.assetId, png)

    expect(first.storageKey).toBe(second.storageKey)
    expect(await readFile(join(root, first.storageKey))).toEqual(png)
    await expect(storage.putVerified('0'.repeat(64), png)).rejects.toThrow(/hash/i)
  })

  it('rejects SVG, signature mismatches, and oversized payloads', async () => {
    await expect(verifyAssetBytes(Buffer.from('<svg/>'), 'image/svg+xml')).rejects.toThrow(/PNG|JPEG|WebP/i)
    await expect(verifyAssetBytes(png, 'image/jpeg')).rejects.toThrow(/does not match/i)
    await expect(verifyAssetBytes(Buffer.alloc(5 * 1024 * 1024 + 1), 'image/png')).rejects.toThrow(/five-megabyte/i)
  })
})
