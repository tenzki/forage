import type { Editor } from '@tiptap/react'
import { Step } from '@tiptap/pm/transform'
import type { EventEnvelope } from '@forage/domain'
import { COMPENSATION_META, type CapturedDocumentEvent } from './eventCapture'

export type DocumentChangeEvent = Extract<EventEnvelope, {
  type: 'document.steps_applied' | 'document.undo_applied' | 'document.redo_applied'
}>

export interface ChangeGroup {
  id: string
  events: Array<Extract<EventEnvelope, { type: 'document.steps_applied' }> | CapturedDocumentEvent>
}

export interface PersistentHistoryState {
  undo: ChangeGroup[]
  redo: ChangeGroup[]
}

export interface HistoryRecord {
  localSequence: number
  supersededBy?: string | null
  envelope: EventEnvelope
}

export type HistoryPageReader = (beforeSequence: number, limit: number) => Promise<readonly HistoryRecord[]>

export function isHistoryReset(event: EventEnvelope, localDeviceId?: string): boolean {
  const external = (event.origin === 'server'
    || (localDeviceId !== undefined && event.deviceId !== localDeviceId))
    && (event.type === 'document.steps_applied'
      || event.type === 'document.undo_applied'
      || event.type === 'document.redo_applied'
      || event.type === 'note.created'
      || ((event.type === 'trash.entry_added' || event.type === 'trash.entry_restored')
        && Boolean(event.payload.document)))
  if (external) return true
  if (event.type === 'document.steps_applied') {
    const groupId = event.changeGroupId ?? event.id
    return event.origin === 'migration' || groupId.startsWith('system:')
  }
  if (event.type === 'trash.entry_added' || event.type === 'trash.entry_restored') {
    return Boolean(event.payload.document)
  }
  return event.type === 'note.created' || event.type === 'document.schema_migrated'
}

export function rebuildPersistentHistory(
  events: readonly EventEnvelope[],
  localDeviceId?: string,
): PersistentHistoryState {
  const state: PersistentHistoryState = { undo: [], redo: [] }
  for (const event of events) {
    if (isHistoryReset(event, localDeviceId)) {
      state.undo = []
      state.redo = []
      continue
    }
    if (event.type === 'document.steps_applied') {
      const groupId = event.changeGroupId ?? event.id
      const current = state.undo[state.undo.length - 1]
      if (current?.id === groupId) current.events.push(event)
      else state.undo.push({ id: groupId, events: [event] })
      state.redo = []
      continue
    }
    if (event.type === 'document.undo_applied') {
      const targets = new Set(event.payload.targetEventIds)
      const index = findGroup(state.undo, targets)
      if (index >= 0) state.redo.push(...state.undo.splice(index, 1))
      continue
    }
    if (event.type === 'document.redo_applied') {
      const targets = new Set(event.payload.targetEventIds)
      const index = findGroup(state.redo, targets)
      if (index >= 0) state.undo.push(...state.redo.splice(index, 1))
    }
  }
  return state
}

export async function loadPersistentHistory(
  readPage: HistoryPageReader,
  latestSequence: number,
  localDeviceId?: string,
  pageSize = 250,
): Promise<PersistentHistoryState> {
  const size = Math.max(1, pageSize)
  let cursor = latestSequence
  let tail: EventEnvelope[] = []
  while (cursor > 0) {
    const page = await readPage(cursor, size)
    if (!page.length) break
    const usable = page.filter((entry) => !entry.supersededBy).map((entry) => entry.envelope)
    let boundary = -1
    for (let index = usable.length - 1; index >= 0; index -= 1) {
      if (isHistoryReset(usable[index], localDeviceId)) { boundary = index; break }
    }
    if (boundary >= 0) {
      tail = usable.slice(boundary + 1).concat(tail)
      break
    }
    tail = usable.concat(tail)
    if (page.length < size) break
    cursor = page[0].localSequence - 1
  }
  return rebuildPersistentHistory(tail, localDeviceId)
}

export function mergeLoadedHistory(
  loaded: PersistentHistoryState,
  recorded: PersistentHistoryState,
): PersistentHistoryState {
  if (!recorded.undo.length && !recorded.redo.length) return loaded
  return {
    undo: [...loaded.undo, ...recorded.undo],
    redo: recorded.undo.length ? recorded.redo : [...loaded.redo, ...recorded.redo],
  }
}

export function dispatchPersistentUndo(editor: Editor, history: PersistentHistoryState): ChangeGroup | null {
  const group = history.undo[history.undo.length - 1]
  if (!group) return null
  const applied = dispatchCompensation(editor, group, 'document.undo_applied')
  history.undo.pop()
  if (applied) history.redo.push(group)
  return group
}

export function dispatchPersistentRedo(editor: Editor, history: PersistentHistoryState): ChangeGroup | null {
  const group = history.redo[history.redo.length - 1]
  if (!group) return null
  const applied = dispatchCompensation(editor, group, 'document.redo_applied')
  history.redo.pop()
  if (applied) history.undo.push(group)
  return group
}

export function recordDocumentChange(
  history: PersistentHistoryState,
  event: DocumentChangeEvent | CapturedDocumentEvent,
): void {
  if (event.type !== 'document.steps_applied') return
  const groupId = event.changeGroupId ?? event.id
  const current = history.undo[history.undo.length - 1]
  if (current?.id === groupId) current.events.push(event)
  else history.undo.push({ id: groupId, events: [event] })
  history.redo = []
}

function dispatchCompensation(
  editor: Editor,
  group: ChangeGroup,
  type: 'document.undo_applied' | 'document.redo_applied',
): boolean {
  const serialized = type === 'document.undo_applied'
    ? [...group.events].reverse().flatMap((event) => event.payload.inverseSteps)
    : group.events.flatMap((event) => event.payload.steps)
  let transaction = editor.state.tr
  try {
    for (const value of serialized) {
      const result = transaction.maybeStep(Step.fromJSON(editor.schema, value))
      if (result.failed) return false
    }
  } catch {
    return false
  }
  transaction.setMeta('addToHistory', false)
  transaction.setMeta(COMPENSATION_META, { type, targetEventIds: group.events.map((event) => event.id) })
  editor.view.dispatch(transaction)
  return true
}

function findGroup(groups: ChangeGroup[], targets: Set<string>): number {
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    if (groups[index].events.some((event) => targets.has(event.id))) return index
  }
  return -1
}
