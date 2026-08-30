import { describe, expect, it } from 'vitest'
import { createOutlineSchema, findSystemNode, repairSystemNodes } from './index'

type ItemOptions = {
  role?: 'inbox' | 'daily-notes' | 'daily-note' | string | null
  date?: string | null
  children?: object[]
  extra?: Record<string, unknown>
}

function item(id: string, text: string, options: ItemOptions = {}) {
  return {
    type: 'listItem',
    attrs: {
      nodeId: id,
      nodeType: 'user',
      collapsed: false,
      bulletKind: 'bullet',
      completed: false,
      systemRole: options.role ?? null,
      dailyDate: options.date ?? null,
      ...options.extra,
    },
    content: [
      { type: 'paragraph', content: text ? [{ type: 'text', text }] : undefined },
      ...(options.children?.length ? [{ type: 'bulletList', content: options.children }] : []),
    ],
  }
}

function doc(items: object[]) {
  return { type: 'doc', content: [{ type: 'bulletList', content: items }] }
}

function roles(value: Record<string, unknown>): Array<{ id: string; role: string | null; date: string | null; text: string }> {
  const schemaDoc = createOutlineSchema().nodeFromJSON(value)
  const found: Array<{ id: string; role: string | null; date: string | null; text: string }> = []
  schemaDoc.descendants((node) => {
    if (node.type.name === 'listItem') {
      found.push({
        id: String(node.attrs.nodeId),
        role: node.attrs.systemRole ?? null,
        date: node.attrs.dailyDate ?? null,
        text: node.firstChild?.textContent ?? '',
      })
    }
  })
  return found
}

describe('system outline nodes', () => {
  it('adds missing canonical roots without claiming title-matching user content', () => {
    const ids = ['created-inbox', 'created-daily']
    const result = repairSystemNodes(doc([
      item('user-inbox', 'Inbox'),
      item('user-daily', 'Daily Notes'),
    ]), () => ids.shift()!)

    expect(result.changed).toBe(true)
    expect(roles(result.doc)).toEqual([
      { id: 'user-inbox', role: null, date: null, text: 'Inbox' },
      { id: 'user-daily', role: null, date: null, text: 'Daily Notes' },
      { id: 'created-inbox', role: 'inbox', date: null, text: 'Inbox' },
      { id: 'created-daily', role: 'daily-notes', date: null, text: 'Daily Notes' },
    ])
  })

  it('keeps the first canonical container and demotes duplicates without losing descendants', () => {
    const result = repairSystemNodes(doc([
      item('inbox-first', 'Primary', { role: 'inbox', children: [item('kept-child', 'Keep me')] }),
      item('inbox-second', 'Duplicate', { role: 'inbox', children: [item('duplicate-child', 'Also keep me')] }),
      item('daily', 'Daily Notes', { role: 'daily-notes' }),
    ]), () => 'unused')

    expect(roles(result.doc)).toEqual([
      { id: 'inbox-first', role: 'inbox', date: null, text: 'Primary' },
      { id: 'kept-child', role: null, date: null, text: 'Keep me' },
      { id: 'inbox-second', role: null, date: null, text: 'Duplicate' },
      { id: 'duplicate-child', role: null, date: null, text: 'Also keep me' },
      { id: 'daily', role: 'daily-notes', date: null, text: 'Daily Notes' },
    ])
    expect(result.issues.map((issue) => issue.code)).toContain('duplicate_inbox')
  })

  it('moves orphaned daily pages below Daily Notes and preserves ids, content, descendants, and attributes', () => {
    const result = repairSystemNodes(doc([
      item('inbox', 'Inbox', { role: 'inbox' }),
      item('orphan', 'Original label', {
        role: 'daily-note',
        date: '2026-08-30',
        children: [item('journal', 'Journal content')],
        extra: { customMetadata: 'preserve-me' },
      }),
      item('daily', 'Daily Notes', { role: 'daily-notes' }),
    ]), () => 'unused')

    const parsed = createOutlineSchema().nodeFromJSON(result.doc)
    const orphan = findSystemNode(parsed, 'daily-note')
    expect(orphan).toMatchObject({ id: 'orphan', ancestorIds: ['daily'], dailyDate: '2026-08-30' })
    expect(orphan?.node.textContent).toContain('Journal content')
    expect(orphan?.node.attrs.customMetadata).toBeUndefined()
    expect(roles(result.doc).map((entry) => entry.id)).toEqual(['inbox', 'daily', 'orphan', 'journal'])
  })

  it('demotes invalid and duplicate dated pages while preserving them as ordinary content', () => {
    const result = repairSystemNodes(doc([
      item('inbox', 'Inbox', { role: 'inbox' }),
      item('daily', 'Daily Notes', {
        role: 'daily-notes',
        children: [
          item('valid', 'Saturday', { role: 'daily-note', date: '2026-08-30' }),
          item('duplicate', 'Duplicate Saturday', { role: 'daily-note', date: '2026-08-30' }),
          item('invalid', 'Impossible', { role: 'daily-note', date: '2026-02-30' }),
        ],
      }),
    ]), () => 'unused')

    expect(roles(result.doc)).toEqual([
      { id: 'inbox', role: 'inbox', date: null, text: 'Inbox' },
      { id: 'daily', role: 'daily-notes', date: null, text: 'Daily Notes' },
      { id: 'valid', role: 'daily-note', date: '2026-08-30', text: 'Saturday' },
      { id: 'duplicate', role: null, date: null, text: 'Duplicate Saturday' },
      { id: 'invalid', role: null, date: null, text: 'Impossible' },
    ])
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      'duplicate_daily_date',
      'invalid_daily_date',
    ]))
  })

  it('normalizes unsupported roles and stray dates without removing unrelated JSON attributes', () => {
    const value = doc([
      item('inbox', 'Inbox', { role: 'inbox', date: '2020-01-01' }),
      item('daily', 'Daily Notes', { role: 'daily-notes' }),
      item('ordinary', 'Ordinary', { role: 'future-role', date: '2026-08-30', extra: { futureAttribute: 'keep' } }),
    ])
    const result = repairSystemNodes(value, () => 'unused')
    const rootItems = ((result.doc.content as Array<Record<string, unknown>>)[0].content as Array<Record<string, unknown>>)

    expect((rootItems[2].attrs as Record<string, unknown>).futureAttribute).toBe('keep')
    expect(roles(result.doc)).toEqual([
      { id: 'inbox', role: 'inbox', date: null, text: 'Inbox' },
      { id: 'daily', role: 'daily-notes', date: null, text: 'Daily Notes' },
      { id: 'ordinary', role: null, date: null, text: 'Ordinary' },
    ])
  })

  it('is byte-for-byte idempotent after the first repair', () => {
    const first = repairSystemNodes(doc([item('ordinary', 'Existing')]), (() => {
      const ids = ['inbox', 'daily']
      return () => ids.shift()!
    })())
    const second = repairSystemNodes(first.doc, () => { throw new Error('must not allocate') })

    expect(second.changed).toBe(false)
    expect(second.issues).toEqual([])
    expect(second.doc).toEqual(first.doc)
  })

  it('coalesces legacy root lists without dropping generated image items', () => {
    const value = {
      type: 'doc',
      content: [
        { type: 'bulletList', content: [
          item('inbox', 'Inbox', { role: 'inbox' }),
          item('daily', 'Daily Notes', { role: 'daily-notes' }),
        ] },
        { type: 'bulletList', content: [{
          type: 'generatedImageItem',
          content: [{ type: 'generatedImage', attrs: { assetId: 'asset-id', alt: 'Keep me' } }],
        }] },
      ],
    }

    const result = repairSystemNodes(value, () => { throw new Error('must not allocate') })
    const parsed = createOutlineSchema().nodeFromJSON(result.doc)

    expect(parsed.childCount).toBe(1)
    expect(Array.from({ length: parsed.firstChild!.childCount }, (_, index) => (
      parsed.firstChild!.child(index).type.name
    ))).toEqual(['listItem', 'listItem', 'generatedImageItem'])
  })
})
