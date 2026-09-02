import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export interface EncryptionKey {
  version: number
  keyBase64: string
}

export interface EncryptedSecret {
  keyVersion: number
  nonce: string
  ciphertext: string
}

function keyBytes(key: EncryptionKey): Buffer {
  const bytes = Buffer.from(key.keyBase64, 'base64')
  if (!Number.isInteger(key.version) || key.version < 1 || bytes.length !== 32) {
    throw new Error('Credential encryption key must be a versioned 32-byte base64 value.')
  }
  return bytes
}

export function encryptSecret(secret: string, key: EncryptionKey): EncryptedSecret {
  if (!secret) throw new Error('Credential secret is required.')
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyBytes(key), nonce)
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final(), cipher.getAuthTag()])
  return {
    keyVersion: key.version,
    nonce: nonce.toString('base64'),
    ciphertext: encrypted.toString('base64'),
  }
}

export function decryptSecret(secret: EncryptedSecret, keys: EncryptionKey[]): string {
  const key = keys.find((candidate) => candidate.version === secret.keyVersion)
  if (!key) throw new Error(`Credential encryption key version ${secret.keyVersion} is unavailable.`)
  try {
    if (Buffer.from(secret.nonce, 'base64').toString('base64') !== secret.nonce
      || Buffer.from(secret.ciphertext, 'base64').toString('base64') !== secret.ciphertext) {
      throw new Error('invalid encoding')
    }
    const nonce = Buffer.from(secret.nonce, 'base64')
    const encrypted = Buffer.from(secret.ciphertext, 'base64')
    if (nonce.length !== 12 || encrypted.length <= 16) throw new Error('invalid ciphertext')
    const tag = encrypted.subarray(encrypted.length - 16)
    const body = encrypted.subarray(0, encrypted.length - 16)
    const decipher = createDecipheriv('aes-256-gcm', keyBytes(key), nonce)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')
  } catch {
    throw new Error('Credential could not be decrypted or failed authentication.')
  }
}

export function redactSecrets(value: string): string {
  return value
    .replace(/\bBearer\s+\S+/gi, '[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/(refresh_token=)[^\s]+/gi, '$1[redacted]')
}
