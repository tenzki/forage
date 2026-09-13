import { describe, expect, it } from 'vitest'
import { queryCanonicalOutline } from './canonicalOutline'

const item = (id: string, text: string, children: unknown[] = [], role: string | null = null) => ({
  type: 'listItem',
  attrs: { nodeId: id, nodeType: 'user', collapsed: false, bulletKind: 'bullet', completed: false, systemRole: role, dailyDate: null },
  content: [
    { type: 'paragraph', ...(text ? { content: [{ type: 'text', text }] } : {}) },
    ...(children.length ? [{ type: 'bulletList', content: children }] : []),
  ],
})

describe('canonical outline query', () => {
  it('resolves live hierarchy, system nodes, empty paragraphs, and trash', () => {
    const query = queryCanonicalOutline({
      doc: { type: 'doc', content: [{ type: 'bulletList', content: [
        item('inbox', 'Inbox', [item('deep', '')], 'inbox'),
        item('sibling', 'Sibling'),
        { type: 'generatedImageItem', content: [{ type: 'generatedImage', attrs: { assetId: 'a'.repeat(64), alt: 'image' } }] },
      ] }] },
      trash: [{ id: 'trash-entry', node: item('trashed', 'Gone') }],
    })

    expect(query.resolve('deep')).toEqual({ state: 'live', node: expect.objectContaining({
      id: 'deep', text: '', parentId: 'inbox', ancestorIds: ['inbox'],
    }) })
    expect(query.ancestors('deep').map((node) => node.id)).toEqual(['inbox', 'deep'])
    expect(query.resolve('inbox')).toEqual({ state: 'live', node: expect.objectContaining({ systemRole: 'inbox' }) })
    expect(query.resolve('trashed')).toEqual({ state: 'trashed', trashEntryId: 'trash-entry' })
    expect(query.resolve('absent')).toEqual({ state: 'missing' })
  })

  it('rejects duplicate live node ids defensively', () => {
    expect(() => queryCanonicalOutline({
      doc: { type: 'doc', content: [{ type: 'bulletList', content: [item('same', 'One'), item('same', 'Two')] }] },
      trash: [],
    })).toThrow('duplicate node id')
  })
})
