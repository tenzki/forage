import { describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import {
  BulletAttributes,
  OutlinerKeymap,
} from '../editor/extensions'
import { BulletNote } from '../editor/bulletNote'
import {
  GeneratedImage,
  GeneratedImageItem,
  OutlineBulletList,
  OutlineListItem,
} from '../editor/generatedImage'
import {
  buildOutlineSnapshot,
  searchSnapshot,
  formatSnapshotResults,
  type OutlineNodeSnapshot,
} from './outlineSnapshot'

function makeEditor(content: object): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: [
      StarterKit.configure({ bulletList: false, listItem: false }),
      OutlineListItem,
      OutlineBulletList,
      GeneratedImageItem,
      GeneratedImage,
      BulletAttributes,
      BulletNote,
      OutlinerKeymap,
    ],
    content,
  })
}

describe('buildOutlineSnapshot', () => {
  it('serialises all text bullets with correct depth and ancestry', () => {
    const editor = makeEditor({
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              attrs: { nodeId: 'a', nodeType: 'user' },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Root note' }] }],
            },
            {
              type: 'listItem',
              attrs: { nodeId: 'b', nodeType: 'user' },
              content: [
                { type: 'paragraph', content: [{ type: 'text', text: 'Second root' }] },
                {
                  type: 'bulletList',
                  content: [
                    {
                      type: 'listItem',
                      attrs: { nodeId: 'c', nodeType: 'user' },
                      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Child of second' }] }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    })

    const snapshot = buildOutlineSnapshot(editor.state.doc)

    expect(snapshot).toEqual([
      { nodeId: 'a', text: 'Root note', depth: 0, ancestorTexts: [] },
      { nodeId: 'b', text: 'Second root', depth: 0, ancestorTexts: [] },
      { nodeId: 'c', text: 'Child of second', depth: 1, ancestorTexts: ['Second root'] },
    ])
  })

  it('skips empty AI placeholder bullets', () => {
    const editor = makeEditor({
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              attrs: { nodeId: 'x', nodeType: 'ai' },
              content: [{ type: 'paragraph' }],
            },
            {
              type: 'listItem',
              attrs: { nodeId: 'y', nodeType: 'user' },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Real note' }] }],
            },
          ],
        },
      ],
    })

    const snapshot = buildOutlineSnapshot(editor.state.doc)

    expect(snapshot).toHaveLength(1)
    expect(snapshot[0].nodeId).toBe('y')
  })

  it('includes non-empty AI bullets', () => {
    const editor = makeEditor({
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              attrs: { nodeId: 'ai1', nodeType: 'ai' },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Generated content' }] }],
            },
          ],
        },
      ],
    })

    const snapshot = buildOutlineSnapshot(editor.state.doc)

    expect(snapshot).toHaveLength(1)
    expect(snapshot[0].text).toBe('Generated content')
  })

  it('respects the byte budget', () => {
    const editor = makeEditor({
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: Array.from({ length: 50 }, (_, i) => ({
            type: 'listItem',
            attrs: { nodeId: `n${i}`, nodeType: 'user' },
            content: [{ type: 'paragraph', text: `Bullet ${i}` }],
          })),
        },
      ],
    })

    // Tiny budget should yield a small snapshot
    const snapshot = buildOutlineSnapshot(editor.state.doc, 50)
    expect(snapshot.length).toBeLessThan(10)
  })
})

describe('searchSnapshot', () => {
  const snapshot: OutlineNodeSnapshot[] = [
    { nodeId: 'a', text: 'Roadmap for Q3', depth: 0, ancestorTexts: [] },
    { nodeId: 'b', text: 'Performance improvements', depth: 1, ancestorTexts: ['Roadmap for Q3'] },
    { nodeId: 'c', text: 'Bug fixes for release', depth: 1, ancestorTexts: ['Roadmap for Q3'] },
    { nodeId: 'd', text: 'Database schema migration', depth: 0, ancestorTexts: [] },
    { nodeId: 'e', text: 'REST API design', depth: 2, ancestorTexts: ['Roadmap for Q3', 'Performance improvements'] },
  ]

  it('matches text content case-insensitively', () => {
    const results = searchSnapshot(snapshot, 'roadmap')
    // 'roadmap' matches 'a' (text), and 'b', 'c', 'e' (ancestor matches)
    expect(results).toHaveLength(4)
    expect(results[0].nodeId).toBe('a')
    expect(results[0].matchField).toBe('text')
    // Ancestor matches come after text matches
    expect(results[1].matchField).toBe('ancestor')
  })

  it('matches ancestor text', () => {
    const results = searchSnapshot(snapshot, 'roadmap for q3')
    expect(results.length).toBeGreaterThan(1)
    // Ancestor matches get lower priority
    const textMatch = results.filter((r) => r.matchField === 'text')
    const ancMatch = results.filter((r) => r.matchField === 'ancestor')
    expect(textMatch).toHaveLength(1) // node 'a' itself
    expect(ancMatch.length).toBeGreaterThan(1) // children of 'a'
  })

  it('returns empty for no match', () => {
    expect(searchSnapshot(snapshot, 'zzzznotfound')).toEqual([])
  })

  it('respects maxResults', () => {
    const results = searchSnapshot(snapshot, 'release roadmap performance', 2)
    expect(results.length).toBeLessThanOrEqual(2)
  })

  it('required non-empty query', () => {
    expect(searchSnapshot(snapshot, '')).toEqual([])
    expect(searchSnapshot(snapshot, '  ')).toEqual([])
  })
})

describe('formatSnapshotResults', () => {
  const snapshot: OutlineNodeSnapshot[] = [
    { nodeId: 'a', text: 'Otter research', depth: 0, ancestorTexts: [] },
    { nodeId: 'b', text: 'Sea otters diet', depth: 1, ancestorTexts: ['Otter research'] },
  ]

  it('formats results as readable text', () => {
    const results = searchSnapshot(snapshot, 'otter')
    const formatted = formatSnapshotResults(results, 'otter')

    expect(formatted).toContain('Found 2 matching node(s)')
    expect(formatted).toContain('Otter research')
    expect(formatted).toContain('Sea otters diet')
    expect(formatted).toContain('Path:')
  })

  it('returns a clear message for no results', () => {
    const formatted = formatSnapshotResults([], 'nope')
    expect(formatted).toContain('No existing nodes match')
  })
})
