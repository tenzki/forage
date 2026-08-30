import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { BulletAttributes } from './extensions'
import { OutlinerUi, getOutlinerUiState } from './outlinerUi'
import { collectBullets } from './outlineModel'
import { currentBulletId } from './outlineModel'
import { formatDailyDate, localCalendarDate, openOrCreateDailyNote } from './dailyNotes'

function item(id: string, text: string, role: string | null = null, date: string | null = null, children: object[] = []) {
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
      { type: 'paragraph', content: text ? [{ type: 'text', text }] : undefined },
      ...(children.length ? [{ type: 'bulletList', content: children }] : []),
    ],
  }
}

function makeEditor(children: object[] = []): Editor {
  return new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit.configure({ trailingNode: false }), BulletAttributes, OutlinerUi],
    content: {
      type: 'doc',
      content: [{ type: 'bulletList', content: [
        item('inbox', 'Inbox', 'inbox'),
        item('daily', 'Daily Notes', 'daily-notes', null, children),
        item('ordinary', 'Ordinary'),
      ] }],
    },
  })
}

describe('daily notes', () => {
  let editor: Editor

  beforeEach(() => { editor = makeEditor() })
  afterEach(() => editor.destroy())

  it('resolves calendar dates in the requested local time zone across date boundaries', () => {
    const instant = new Date('2026-08-30T00:30:00.000Z')
    expect(localCalendarDate(instant, 'Europe/Belgrade')).toBe('2026-08-30')
    expect(localCalendarDate(instant, 'America/Los_Angeles')).toBe('2026-08-29')
    expect(localCalendarDate(new Date('2026-03-29T00:30:00.000Z'), 'Europe/Belgrade')).toBe('2026-03-29')
  })

  it('formats the persisted date for the locale without changing its identity', () => {
    expect(formatDailyDate('2026-08-30', 'en-US')).toBe('August 30, 2026')
    expect(formatDailyDate('2026-08-30', 'en-GB')).toBe('30 August 2026')
  })

  it('creates and focuses one direct daily page, then reuses it on the same date', () => {
    const ids = ['today', 'today-entry']
    const first = openOrCreateDailyNote(editor, {
      now: new Date('2026-08-30T08:00:00.000Z'),
      timeZone: 'Europe/Belgrade',
      locale: 'en-US',
      nextId: () => ids.shift()!,
    })
    const second = openOrCreateDailyNote(editor, {
      now: new Date('2026-08-30T20:00:00.000Z'),
      timeZone: 'Europe/Belgrade',
      locale: 'sr-RS',
      nextId: () => { throw new Error('must reuse') },
    })

    expect(first).toEqual({ id: 'today', date: '2026-08-30', created: true })
    expect(second).toEqual({ id: 'today', date: '2026-08-30', created: false })
    expect(collectBullets(editor.state.doc).filter((entry) => entry.systemRole === 'daily-note')).toHaveLength(1)
    expect(collectBullets(editor.state.doc).find((entry) => entry.id === 'today')).toMatchObject({
      ancestorIds: ['daily'],
      text: formatDailyDate('2026-08-30', 'sr-RS'),
    })
    expect(getOutlinerUiState(editor).zoomId).toBe('today')
    expect(collectBullets(editor.state.doc).find((entry) => entry.id === currentBulletId(editor))).toMatchObject({
      id: 'today-entry',
      text: '',
      ancestorIds: ['daily', 'today'],
      systemRole: null,
    })
  })

  it('keeps managed page creation out of user undo history', () => {
    const ordinary = collectBullets(editor.state.doc).find((entry) => entry.id === 'ordinary')!
    editor.commands.setTextSelection(ordinary.pos + 2 + ordinary.text.length)
    editor.commands.insertContent(' edited')

    const ids = ['today', 'today-entry']
    openOrCreateDailyNote(editor, {
      now: new Date('2026-08-30T08:00:00.000Z'),
      timeZone: 'Europe/Belgrade',
      locale: 'en-US',
      nextId: () => ids.shift()!,
    })
    editor.commands.undo()

    expect(collectBullets(editor.state.doc).find((entry) => entry.id === 'ordinary')?.text).toBe('Ordinary')
    expect(collectBullets(editor.state.doc).find((entry) => entry.id === 'today-entry')).toBeTruthy()
  })

  it('inserts new pages newest-first while preserving ordinary child order', () => {
    editor.destroy()
    editor = makeEditor([
      item('older', 'August 28', 'daily-note', '2026-08-28'),
      item('ordinary-a', 'Pinned context'),
      item('oldest', 'August 27', 'daily-note', '2026-08-27'),
      item('ordinary-b', 'More context'),
    ])

    openOrCreateDailyNote(editor, {
      now: new Date('2026-08-29T12:00:00.000Z'),
      timeZone: 'UTC',
      locale: 'en-US',
      nextId: () => 'newer',
    })

    const directChildren = collectBullets(editor.state.doc)
      .filter((entry) => entry.ancestorIds.length === 1 && entry.ancestorIds[0] === 'daily')
      .map((entry) => entry.id)
    expect(directChildren).toEqual(['newer', 'older', 'ordinary-a', 'oldest', 'ordinary-b'])
  })

  it('creates the next local date without rewriting an earlier page after a time-zone change', () => {
    openOrCreateDailyNote(editor, {
      now: new Date('2026-08-30T00:30:00.000Z'), timeZone: 'Europe/Belgrade',
      nextId: () => 'belgrade-page', locale: 'en-US',
    })
    openOrCreateDailyNote(editor, {
      now: new Date('2026-08-30T00:30:00.000Z'), timeZone: 'America/Los_Angeles',
      nextId: () => 'la-page', locale: 'en-US',
    })

    expect(collectBullets(editor.state.doc)
      .filter((entry) => entry.systemRole === 'daily-note')
      .map((entry) => [entry.id, entry.dailyDate]))
      .toEqual([['belgrade-page', '2026-08-30'], ['la-page', '2026-08-29']])
  })

  it('opens or creates an explicitly selected calendar date', () => {
    const ids = ['selected-date', 'selected-date-entry']

    const result = openOrCreateDailyNote(editor, {
      date: '2026-08-12',
      locale: 'en-US',
      nextId: () => ids.shift()!,
    })

    expect(result).toEqual({ id: 'selected-date', date: '2026-08-12', created: true })
    expect(collectBullets(editor.state.doc).find((entry) => entry.id === 'selected-date')).toMatchObject({
      dailyDate: '2026-08-12',
      text: 'August 12, 2026',
      ancestorIds: ['daily'],
    })
  })
})
