import { beforeEach, describe, expect, it, vi } from 'vitest'

const fsMocks = vi.hoisted(() => ({
  exists: vi.fn(async () => true),
  mkdir: vi.fn(async () => undefined),
  readTextFile: vi.fn(async () => ''),
  writeTextFile: vi.fn(async () => undefined),
}))

vi.mock('@tauri-apps/api/path', () => ({
  homeDir: async () => '/home/test',
  join: async (...parts: string[]) => parts.join('/'),
}))

vi.mock('@tauri-apps/plugin-fs', () => fsMocks)

import { createDebouncedSaver, normalizeOutline } from './outlineFile'

const doc = {
  type: 'doc',
  content: [{ type: 'bulletList', content: [] }],
}

const normalizedDoc = {
  type: 'doc',
  content: [{
    type: 'bulletList',
    content: [{
      type: 'listItem',
      attrs: {
        nodeId: expect.any(String),
        nodeType: 'user',
        collapsed: false,
        bulletKind: 'bullet',
        completed: false,
      },
      content: [{ type: 'paragraph' }],
    }],
  }],
}

describe('outline persistence', () => {
  beforeEach(() => vi.clearAllMocks())

  it('migrates version 1 files without losing the document', () => {
    expect(normalizeOutline({ version: 1, doc })).toEqual({
      version: 4,
      doc: normalizedDoc,
      trash: [],
      shortcuts: [],
    })
  })

  it('migrates version 2 files with empty shortcuts', () => {
    expect(normalizeOutline({ version: 2, doc, trash: [] })).toEqual({
      version: 4,
      doc: normalizedDoc,
      trash: [],
      shortcuts: [],
    })
  })

  it('repairs an empty document with stray root content', () => {
    const malformed = {
      type: 'doc',
      content: [{ type: 'bulletList', content: [] }, { type: 'paragraph' }],
    }
    expect(normalizeOutline({ version: 1, doc: malformed }).doc).toEqual(normalizedDoc)
  })

  it('migrates version 3 shortcuts and accepts named searches in version 4', () => {
    expect(normalizeOutline({
      version: 3,
      doc,
      trash: [],
      shortcuts: [{ type: 'tag', target: 'research' }],
    })).toMatchObject({
      version: 4,
      shortcuts: [{ type: 'tag', target: 'research' }],
    })
    expect(normalizeOutline({
      version: 4,
      doc,
      trash: [],
      shortcuts: [{ type: 'search', target: 'is:open', label: 'Open tasks', scopeId: null }],
    })).toMatchObject({
      version: 4,
      shortcuts: [{ type: 'search', target: 'is:open', label: 'Open tasks', scopeId: null }],
    })
  })

  it('rejects malformed persisted input', () => {
    expect(() => normalizeOutline({ version: 2, doc, trash: [{}] })).toThrow(/invalid format/)
    expect(() => normalizeOutline({ version: 3, doc, trash: [], shortcuts: [{}] })).toThrow(/invalid format/)
    expect(() => normalizeOutline(null)).toThrow(/valid document/)
  })

  it('retains a failed write so the user can retry it', async () => {
    fsMocks.writeTextFile
      .mockRejectedValueOnce(new Error('iCloud unavailable'))
      .mockResolvedValueOnce(undefined)
    const onError = vi.fn()
    const saver = createDebouncedSaver(60_000, onError)
    saver.schedule({ version: 4, doc, trash: [], shortcuts: [] })

    await expect(saver.flush()).rejects.toThrow('iCloud unavailable')
    expect(saver.hasPending()).toBe(true)
    await expect(saver.flush()).resolves.toBeUndefined()
    expect(saver.hasPending()).toBe(false)
  })
})
