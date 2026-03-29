import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto'
import {
  readFileSync,
  writeFileSync,
  existsSync,
  chmodSync,
} from 'node:fs'
import { join } from 'node:path'

const ALGORITHM = 'aes-256-gcm' as const
const KEY_FILE = 'encryption.key'
const SETTINGS_FILE = 'settings.json.enc'

/**
 * Encrypt a JSON-serializable object using AES-256-GCM.
 * Format: iv (12 bytes) + authTag (16 bytes) + ciphertext
 */
export function encryptSettings(data: object, key: Buffer): Buffer {
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(data), 'utf8'),
    cipher.final(),
  ])
  const authTag = cipher.getAuthTag()
  return Buffer.concat([iv, authTag, encrypted])
}

/**
 * Decrypt a buffer produced by encryptSettings.
 * Throws if tampered (auth tag verification fails).
 */
export function decryptSettings(encryptedBuf: Buffer, key: Buffer): object {
  if (encryptedBuf.length < 28) {
    throw new Error('Encrypted buffer too short')
  }
  const iv = encryptedBuf.subarray(0, 12)
  const authTag = encryptedBuf.subarray(12, 28)
  const ciphertext = encryptedBuf.subarray(28)
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return JSON.parse(decrypted.toString('utf8')) as object
}

/**
 * Read or create the 32-byte encryption key stored in appDataDir/encryption.key.
 * If the file is missing, generates a new key and writes it with mode 0o600.
 */
export function getOrCreateEncryptionKey(appDataDir: string): Buffer {
  const keyPath = join(appDataDir, KEY_FILE)
  if (existsSync(keyPath)) {
    return readFileSync(keyPath)
  }
  const key = randomBytes(32)
  writeFileSync(keyPath, key)
  chmodSync(keyPath, 0o600)
  return key
}

/**
 * Load and decrypt settings from appDataDir/settings.json.enc.
 * Returns {} if file does not exist.
 */
export function loadSettings(appDataDir: string): object {
  const settingsPath = join(appDataDir, SETTINGS_FILE)
  if (!existsSync(settingsPath)) {
    return {}
  }
  const key = getOrCreateEncryptionKey(appDataDir)
  const encryptedBuf = readFileSync(settingsPath)
  return decryptSettings(encryptedBuf, key)
}

/**
 * Encrypt and write data to appDataDir/settings.json.enc.
 */
export function saveSettings(appDataDir: string, data: object): void {
  const key = getOrCreateEncryptionKey(appDataDir)
  const encrypted = encryptSettings(data, key)
  const settingsPath = join(appDataDir, SETTINGS_FILE)
  writeFileSync(settingsPath, encrypted)
}
