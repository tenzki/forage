/**
 * Keystore unit tests using Node.js built-in test runner.
 * Run with: node --test keystore.test.ts
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  encryptSettings,
  decryptSettings,
  getOrCreateEncryptionKey,
  loadSettings,
  saveSettings,
} from './keystore.ts'

// ---------- encryptSettings / decryptSettings round-trip ----------

test('round-trip: encrypt then decrypt returns original object', () => {
  const key = randomBytes(32)
  const original = { anthropicKey: 'sk-ant-test', model: 'claude-opus-4-5' }
  const encrypted = encryptSettings(original, key)
  const decrypted = decryptSettings(encrypted, key) as typeof original
  assert.deepStrictEqual(decrypted, original)
})

test('round-trip: empty object survives encrypt/decrypt', () => {
  const key = randomBytes(32)
  const encrypted = encryptSettings({}, key)
  const decrypted = decryptSettings(encrypted, key)
  assert.deepStrictEqual(decrypted, {})
})

test('round-trip: nested object survives encrypt/decrypt', () => {
  const key = randomBytes(32)
  const original = {
    providers: {
      anthropic: { apiKey: 'sk-ant', enabled: true },
      openai: { apiKey: 'sk-openai', enabled: false },
    },
    defaultModel: 'claude-opus-4-5',
  }
  const encrypted = encryptSettings(original, key)
  const decrypted = decryptSettings(encrypted, key) as typeof original
  assert.deepStrictEqual(decrypted, original)
})

// ---------- tampered-data rejection ----------

test('tampered ciphertext causes decryption to throw', () => {
  const key = randomBytes(32)
  const encrypted = encryptSettings({ secret: 'value' }, key)
  // Flip a byte in the ciphertext portion (after 12 iv + 16 authTag = 28 bytes)
  const tampered = Buffer.from(encrypted)
  tampered[28] ^= 0xff
  assert.throws(() => decryptSettings(tampered, key))
})

test('tampered auth tag causes decryption to throw', () => {
  const key = randomBytes(32)
  const encrypted = encryptSettings({ secret: 'value' }, key)
  const tampered = Buffer.from(encrypted)
  // Flip a byte inside the auth tag (bytes 12-27)
  tampered[12] ^= 0x01
  assert.throws(() => decryptSettings(tampered, key))
})

test('wrong key causes decryption to throw', () => {
  const key1 = randomBytes(32)
  const key2 = randomBytes(32)
  const encrypted = encryptSettings({ secret: 'value' }, key1)
  assert.throws(() => decryptSettings(encrypted, key2))
})

test('buffer too short throws', () => {
  const key = randomBytes(32)
  assert.throws(() => decryptSettings(Buffer.alloc(10), key))
})

// ---------- getOrCreateEncryptionKey ----------

test('getOrCreateEncryptionKey creates key on first call', () => {
  const dir = mkdtempSync(join(tmpdir(), 'keystore-test-'))
  try {
    const key = getOrCreateEncryptionKey(dir)
    assert.strictEqual(key.length, 32)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test('getOrCreateEncryptionKey returns same key on subsequent calls', () => {
  const dir = mkdtempSync(join(tmpdir(), 'keystore-test-'))
  try {
    const key1 = getOrCreateEncryptionKey(dir)
    const key2 = getOrCreateEncryptionKey(dir)
    assert.deepStrictEqual(key1, key2)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

// ---------- loadSettings / saveSettings ----------

test('loadSettings returns empty object when file missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'keystore-test-'))
  try {
    const result = loadSettings(dir)
    assert.deepStrictEqual(result, {})
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test('saveSettings then loadSettings returns original data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'keystore-test-'))
  try {
    const data = { apiKey: 'sk-test-123', model: 'gpt-4' }
    saveSettings(dir, data)
    const loaded = loadSettings(dir) as typeof data
    assert.deepStrictEqual(loaded, data)
  } finally {
    rmSync(dir, { recursive: true })
  }
})

test('saveSettings overwrites previous data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'keystore-test-'))
  try {
    saveSettings(dir, { key: 'old' })
    saveSettings(dir, { key: 'new' })
    const loaded = loadSettings(dir) as { key: string }
    assert.strictEqual(loaded.key, 'new')
  } finally {
    rmSync(dir, { recursive: true })
  }
})
