import { describe, expect, it } from 'vitest'
import { createOutlineSchema } from '@forage/document'
import { preservesProtectedSystemNodes, validateSystemNodeAction } from './systemNodeGuards'

function item(id: string, role: string | null = null, date: string | null = null, children: object[] = []) {
  return {
    type: 'listItem',
    attrs: {
      nodeId: id,
      nodeType: 'user',
      collapsed: false,
      bulletKind: 'bullet',
      completed: false,
      systemRole: role,
      dailyDate: date,
    },
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: id }] },
      ...(children.length ? [{ type: 'bulletList', content: children }] : []),
    ],
  }
}

function documentWith(items: object[]) {
  return createOutlineSchema().nodeFromJSON({
    type: 'doc',
    content: [{
      type: 'bulletList',
      content: items,
    }],
  })
}

function outline() {
  return documentWith([
    item('inbox', 'inbox', null, [item('inbox-child')]),
    item('daily', 'daily-notes', null, [
      item('today', 'daily-note', '2026-08-30', [item('journal')]),
    ]),
    item('ordinary'),
  ])
}

describe('system-node structural guards', () => {
  it.each(['move', 'purge', 'duplicate', 'convert', 'replace'] as const)(
    'rejects %s on protected role holders',
    (action) => {
      expect(validateSystemNodeAction(outline(), action, 'inbox')).toMatchObject({ allowed: false })
      expect(validateSystemNodeAction(outline(), action, 'today')).toMatchObject({ allowed: false })
    },
  )

  it('allows only daily-note roots to use the explicit trash action', () => {
    expect(validateSystemNodeAction(outline(), 'trash', 'today')).toEqual({ allowed: true })
    expect(validateSystemNodeAction(outline(), 'trash', 'inbox')).toMatchObject({ allowed: false })
    expect(validateSystemNodeAction(outline(), 'trash', 'daily')).toMatchObject({ allowed: false })
  })

  it('scopes daily-note disappearance to the exact authorized node ID and transaction', () => {
    const withoutToday = documentWith([
      item('inbox', 'inbox', null, [item('inbox-child')]),
      item('daily', 'daily-notes'),
      item('ordinary'),
    ])
    const withoutTodayOrInbox = documentWith([
      item('daily', 'daily-notes'),
      item('ordinary'),
    ])

    expect(preservesProtectedSystemNodes(outline(), withoutToday, null, 'today')).toBe(true)
    expect(preservesProtectedSystemNodes(outline(), withoutToday, null, 'other-day')).toBe(false)
    expect(preservesProtectedSystemNodes(outline(), withoutTodayOrInbox, null, 'today')).toBe(false)
    expect(preservesProtectedSystemNodes(outline(), withoutToday)).toBe(false)
  })

  it('allows ordinary descendants to use normal structural actions', () => {
    expect(validateSystemNodeAction(outline(), 'move', 'inbox-child', 'ordinary')).toEqual({ allowed: true })
    expect(validateSystemNodeAction(outline(), 'trash', 'journal')).toEqual({ allowed: true })
    expect(validateSystemNodeAction(outline(), 'convert', 'journal')).toEqual({ allowed: true })
  })

  it('allows ordinary content to move below protected destinations', () => {
    expect(validateSystemNodeAction(outline(), 'move', 'ordinary', 'inbox')).toEqual({ allowed: true })
    expect(validateSystemNodeAction(outline(), 'move', 'ordinary', 'today')).toEqual({ allowed: true })
  })

  it('rejects missing sources and cyclic moves independently of role protection', () => {
    expect(validateSystemNodeAction(outline(), 'move', 'missing', 'ordinary')).toMatchObject({ allowed: false })
    expect(validateSystemNodeAction(outline(), 'move', 'daily', 'journal')).toMatchObject({ allowed: false })
  })
})
