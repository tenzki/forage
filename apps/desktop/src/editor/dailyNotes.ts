import type { Editor } from '@tiptap/core'
import { findSystemNode, isCanonicalDailyDate } from '@forage/document'
import { collectBullets, focusFirstChildOrCreate, updateBulletText } from './outlineModel'
import { setZoom } from './outlinerUi'
import { SYSTEM_MAINTENANCE_META } from './systemNodeGuards'

export interface OpenDailyNoteOptions {
  date?: string
  now?: Date
  timeZone?: string
  locale?: string
  nextId: () => string
}

export interface DailyNoteResult {
  id: string
  date: string
  created: boolean
}

export function localCalendarDate(now: Date, timeZone?: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const values = new Map(parts.map((part) => [part.type, part.value]))
  return `${values.get('year')}-${values.get('month')}-${values.get('day')}`
}

export function formatDailyDate(dailyDate: string, locale?: string): string {
  if (!isCanonicalDailyDate(dailyDate)) throw new Error(`Invalid daily date: ${dailyDate}`)
  const [year, month, day] = dailyDate.split('-').map(Number)
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'long',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day)))
}

function focus(editor: Editor, id: string, nextId: () => string): void {
  setZoom(editor, id)
  focusFirstChildOrCreate(editor, id, nextId)
}

export function openOrCreateDailyNote(editor: Editor, options: OpenDailyNoteOptions): DailyNoteResult | null {
  const container = findSystemNode(editor.state.doc, 'daily-notes')
  if (!container) return null
  if (options.date !== undefined && !isCanonicalDailyDate(options.date)) {
    throw new Error(`Invalid daily date: ${options.date}`)
  }
  const date = options.date ?? localCalendarDate(options.now ?? new Date(), options.timeZone)
  const existing = collectBullets(editor.state.doc).find((entry) => (
    entry.systemRole === 'daily-note'
    && entry.dailyDate === date
    && entry.ancestorIds.length === 1
    && entry.ancestorIds[0] === container.id
  ))
  if (existing) {
    const label = formatDailyDate(date, options.locale)
    if (existing.text !== label) updateBulletText(editor, existing.id, label, { allowProtectedTitle: true })
    focus(editor, existing.id, options.nextId)
    return { id: existing.id, date, created: false }
  }

  const id = options.nextId()
  const paragraph = editor.schema.nodes.paragraph.create(
    null,
    editor.schema.text(formatDailyDate(date, options.locale)),
  )
  const item = editor.schema.nodes.listItem.create({
    nodeId: id,
    nodeType: 'user',
    collapsed: false,
    bulletKind: 'bullet',
    completed: false,
    systemRole: 'daily-note',
    dailyDate: date,
  }, paragraph)

  let nestedListOffset = -1
  let childOffset = 0
  let nestedList = null as typeof container.node | null
  container.node.forEach((child) => {
    if (nestedListOffset < 0 && child.type === editor.schema.nodes.bulletList) {
      nestedListOffset = childOffset
      nestedList = child
    }
    childOffset += child.nodeSize
  })

  const transaction = editor.state.tr
  transaction.setMeta(SYSTEM_MAINTENANCE_META, true)
  transaction.setMeta('addToHistory', false)
  if (!nestedList || nestedListOffset < 0) {
    transaction.insert(
      container.pos + container.node.nodeSize - 1,
      editor.schema.nodes.bulletList.create(null, item),
    )
  } else {
    let insertionIndex = 0
    let lastDailyIndex = -1
    let foundOlder = false
    for (let index = 0; index < nestedList.childCount; index += 1) {
      const child = nestedList.child(index)
      const childDate = child.attrs.systemRole === 'daily-note' ? child.attrs.dailyDate : null
      if (!isCanonicalDailyDate(childDate)) continue
      lastDailyIndex = index
      if (childDate < date) {
        insertionIndex = index
        foundOlder = true
        break
      }
    }
    if (!foundOlder) insertionIndex = lastDailyIndex + 1
    let insertionOffset = 0
    for (let index = 0; index < insertionIndex; index += 1) insertionOffset += nestedList.child(index).nodeSize
    const listPos = container.pos + 1 + nestedListOffset
    transaction.insert(listPos + 1 + insertionOffset, item)
  }
  editor.view.dispatch(transaction.scrollIntoView())
  focus(editor, id, options.nextId)
  return { id, date, created: true }
}
