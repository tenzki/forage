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

export function rebuildPersistentHistory(
  events: readonly EventEnvelope[],
  localDeviceId?: string,
): PersistentHistoryState {
  const state: PersistentHistoryState = { undo: [], redo: [] }
  for (const event of events) {
    const externalDocumentChange = (event.origin === 'server'
      || (localDeviceId !== undefined && event.deviceId !== localDeviceId))
      && (event.type === 'document.steps_applied'
        || event.type === 'document.undo_applied'
        || event.type === 'document.redo_applied'
        || event.type === 'note.created'
        || ((event.type === 'trash.entry_added' || event.type === 'trash.entry_restored')
          && Boolean(event.payload.document)))
    if (externalDocumentChange) {
      state.undo = []
      state.redo = []
      continue
    }
    if (event.type === 'document.steps_applied') {
      const groupId = event.changeGroupId ?? event.id
      if (event.origin === 'migration' || groupId.startsWith('system:')) {
        state.undo = []
        state.redo = []
        continue
      }
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
      continue
    }
    if ((event.type === 'trash.entry_added' || event.type === 'trash.entry_restored')
      && event.payload.document) {
      state.undo = []
      state.redo = []
      continue
    }
    if (event.type === 'note.created' || event.type === 'document.schema_migrated') {
      state.undo = []
      state.redo = []
    }
  }
  return state
}

export function dispatchPersistentUndo(editor: Editor, history: PersistentHistoryState): ChangeGroup | null {
  const group = history.undo[history.undo.length - 1]
  if (!group) return null
  dispatchCompensation(editor, group, 'document.undo_applied')
  history.undo.pop()
  history.redo.push(group)
  return group
}

export function dispatchPersistentRedo(editor: Editor, history: PersistentHistoryState): ChangeGroup | null {
  const group = history.redo[history.redo.length - 1]
  if (!group) return null
  dispatchCompensation(editor, group, 'document.redo_applied')
  history.redo.pop()
  history.undo.push(group)
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
): void {
  const serialized = type === 'document.undo_applied'
    ? [...group.events].reverse().flatMap((event) => event.payload.inverseSteps)
    : group.events.flatMap((event) => event.payload.steps)
  let transaction = editor.state.tr
  for (const value of serialized) transaction = transaction.step(Step.fromJSON(editor.schema, value))
  transaction.setMeta('addToHistory', false)
  transaction.setMeta(COMPENSATION_META, { type, targetEventIds: group.events.map((event) => event.id) })
  editor.view.dispatch(transaction)
}

function findGroup(groups: ChangeGroup[], targets: Set<string>): number {
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    if (groups[index].events.some((event) => targets.has(event.id))) return index
  }
  return -1
}
