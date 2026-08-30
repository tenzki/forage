import { createHash, randomUUID } from 'node:crypto'
import { access, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const MAX_ASSET_BYTES = 5 * 1024 * 1024
export type AssetMediaType = 'image/png' | 'image/jpeg' | 'image/webp'

export interface VerifiedAsset {
  assetId: string
  mediaType: AssetMediaType
  byteSize: number
}

export async function verifyAssetBytes(bytes: Uint8Array, declared: string): Promise<VerifiedAsset> {
  if (bytes.byteLength === 0) throw new Error('Asset content is empty.')
  if (bytes.byteLength > MAX_ASSET_BYTES) throw new Error('Asset exceeds the five-megabyte limit.')
  const detected = detectMediaType(bytes)
  if (!detected) throw new Error('Only PNG, JPEG, and WebP assets are supported.')
  if (detected !== declared) throw new Error(`Declared media type ${declared} does not match detected ${detected}.`)
  return {
    assetId: createHash('sha256').update(bytes).digest('hex'),
    mediaType: detected,
    byteSize: bytes.byteLength,
  }
}

export interface AssetStorage {
  ready(): Promise<boolean>
  putVerified(assetId: string, bytes: Uint8Array): Promise<{ storageKey: string }>
  read(assetId: string): Promise<Buffer>
}

export class FileSystemAssetStorage implements AssetStorage {
  constructor(private readonly root: string) {}

  async ready(): Promise<boolean> {
    try {
      await mkdir(this.root, { recursive: true })
      await access(this.root)
      return true
    } catch { return false }
  }

  async putVerified(assetId: string, bytes: Uint8Array): Promise<{ storageKey: string }> {
    requireAssetId(assetId)
    const actual = createHash('sha256').update(bytes).digest('hex')
    if (actual !== assetId) throw new Error('Asset hash does not match caller identifier.')
    const storageKey = `${assetId.slice(0, 2)}/${assetId.slice(2, 4)}/${assetId}`
    const target = join(this.root, storageKey)
    await mkdir(dirname(target), { recursive: true })
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
      const file = await open(temporary, 'wx')
      try {
        await file.writeFile(bytes)
        await file.sync()
      } finally {
        await file.close()
      }
      await rename(temporary, target)
    } catch (error) {
      await rm(temporary, { force: true })
      try {
        const existing = await readFile(target)
        if (createHash('sha256').update(existing).digest('hex') === assetId) return { storageKey }
      } catch { /* preserve the original write error */ }
      throw error
    }
    return { storageKey }
  }

  async read(assetId: string): Promise<Buffer> {
    requireAssetId(assetId)
    const storageKey = `${assetId.slice(0, 2)}/${assetId.slice(2, 4)}/${assetId}`
    const bytes = await readFile(join(this.root, storageKey))
    if (createHash('sha256').update(bytes).digest('hex') !== assetId) {
      throw new Error('Stored asset hash verification failed.')
    }
    return bytes
  }
}

function requireAssetId(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid SHA-256 asset identifier.')
}

function detectMediaType(bytes: Uint8Array): AssetMediaType | null {
  const starts = (signature: number[]) => signature.every((byte, index) => bytes[index] === byte)
  if (starts([137, 80, 78, 71, 13, 10, 26, 10])) return 'image/png'
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (bytes.byteLength >= 12
    && Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF'
    && Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP') return 'image/webp'
  return null
}
