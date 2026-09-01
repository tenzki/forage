import { describe, expect, it } from 'vitest'
import { sha256Hex, sha256HexSync } from './checkpoint'

describe('synchronous SHA-256', () => {
  it('matches the WebCrypto implementation for ASCII and Unicode input', async () => {
    for (const value of ['', 'abc', 'Forage 🌿 белешка']) {
      expect(sha256HexSync(value)).toBe(await sha256Hex(value))
    }
  })
})
