// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { decryptSecret, encryptSecret, redactSecrets } from './credentialCrypto'

const key = Buffer.alloc(32, 7).toString('base64')

describe('server credential encryption', () => {
  it('round-trips authenticated ciphertext with a versioned external key', () => {
    const encrypted = encryptSecret('sk-server-secret', { version: 3, keyBase64: key })
    expect(encrypted.keyVersion).toBe(3)
    expect(encrypted.nonce).not.toContain('server-secret')
    expect(encrypted.ciphertext).not.toContain('server-secret')
    expect(decryptSecret(encrypted, [{ version: 3, keyBase64: key }])).toBe('sk-server-secret')
  })

  it('rejects corruption and unknown key versions without exposing plaintext', () => {
    const encrypted = encryptSecret('refresh-secret', { version: 1, keyBase64: key })
    expect(() => decryptSecret({ ...encrypted, ciphertext: `${encrypted.ciphertext}A` }, [{ version: 1, keyBase64: key }])).toThrow(/decrypt/i)
    expect(() => decryptSecret(encrypted, [{ version: 2, keyBase64: key }])).toThrow(/key version/i)
  })

  it('redacts common provider secret shapes from public logging', () => {
    expect(redactSecrets('Bearer abc123 sk-private refresh_token=rotate-me')).toBe('[redacted] [redacted] refresh_token=[redacted]')
  })
})
