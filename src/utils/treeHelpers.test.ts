import { describe, it, expect } from 'vitest'
import { extractText } from '../types/tree'
import { positionForInsertAfter, positionForMove } from './treeHelpers'
import type { TreeNode } from '../types/tree'

// ─── extractText tests ────────────────────────────────────────────────────────

describe('extractText', () => {
  it('extracts plain text from a ProseMirror paragraph', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'hello' }],
        },
      ],
    }
    expect(extractText(doc)).toBe('hello')
  })

  it('returns empty string for an empty doc', () => {
    const doc = { type: 'doc', content: [] }
    expect(extractText(doc)).toBe('')
  })

  it('returns empty string for null', () => {
    expect(extractText(null)).toBe('')
  })

  it('concatenates text across multiple paragraphs', () => {
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'hello' }],
        },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: ' world' }],
        },
      ],
    }
    expect(extractText(doc)).toBe('hello world')
  })

  it('returns empty string for a doc with paragraph but no text nodes', () => {
    const doc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [] }],
    }
    expect(extractText(doc)).toBe('')
  })
})

// ─── positionForInsertAfter tests ─────────────────────────────────────────────

/** Build a minimal TreeNode with given position string */
function makeNode(id: string, position: string): TreeNode {
  return {
    id,
    name: id,
    content: null,
    position,
    collapsed: false,
    parent_id: null,
    node_type: 'note',
    children: [],
  }
}

describe('positionForInsertAfter', () => {
  it('returns first key for empty siblings list', () => {
    const pos = positionForInsertAfter([], -1)
    expect(typeof pos).toBe('string')
    expect(pos.length).toBeGreaterThan(0)
  })

  it('returns a key between prev and next when inserting in the middle', () => {
    const siblings = [makeNode('a', 'a0'), makeNode('b', 'a2')]
    // afterIndex=0 means insert after first (a0), before second (a2)
    const pos = positionForInsertAfter(siblings, 0)
    expect(pos > 'a0').toBe(true)
    expect(pos < 'a2').toBe(true)
  })

  it('returns a key after the last element when inserting at end', () => {
    const siblings = [makeNode('a', 'a0'), makeNode('b', 'a1')]
    // afterIndex = siblings.length - 1 (last)
    const pos = positionForInsertAfter(siblings, 1)
    expect(pos > 'a1').toBe(true)
  })

  it('returns a key before the first element when inserting at start (afterIndex=-1)', () => {
    const siblings = [makeNode('a', 'a1'), makeNode('b', 'a2')]
    // afterIndex=-1 means insert before first
    const pos = positionForInsertAfter(siblings, -1)
    expect(pos < 'a1').toBe(true)
  })
})

// ─── positionForMove tests ────────────────────────────────────────────────────

describe('positionForMove', () => {
  it('returns a valid position when moving to target index', () => {
    const siblings = [
      makeNode('a', 'a0'),
      makeNode('b', 'a1'),
      makeNode('c', 'a2'),
    ]
    // Move 'c' to index 0 (before 'a' and 'b')
    const pos = positionForMove(siblings, 0, ['c'])
    expect(typeof pos).toBe('string')
    expect(pos.length).toBeGreaterThan(0)
  })

  it('excludes dragged items before calculating position', () => {
    const siblings = [
      makeNode('a', 'a0'),
      makeNode('drag', 'a1'),
      makeNode('b', 'a2'),
    ]
    // Move 'drag' to index 0 — it should be excluded from siblings when computing
    const pos = positionForMove(siblings, 0, ['drag'])
    // Result should be before 'a0' (insert before first remaining item)
    expect(pos < 'a0').toBe(true)
  })
})
