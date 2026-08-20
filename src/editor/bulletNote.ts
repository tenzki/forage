import { Node, type Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import { currentBulletId, findBullet, type BulletEntry } from './outlineModel'

interface NoteLocation {
  pos: number
  nodeSize: number
}

function noteLocation(entry: BulletEntry): NoteLocation | null {
  let pos = entry.pos + 1
  for (let index = 0; index < entry.node.childCount; index += 1) {
    const child = entry.node.child(index)
    if (child.type.name === 'bulletNote') return { pos, nodeSize: child.nodeSize }
    pos += child.nodeSize
  }
  return null
}

export function hasBulletNote(editor: Editor, nodeId: string): boolean {
  const entry = findBullet(editor.state.doc, nodeId)
  return Boolean(entry && noteLocation(entry))
}

export function focusOrCreateBulletNote(editor: Editor, nodeId: string): boolean {
  const entry = findBullet(editor.state.doc, nodeId)
  const noteType = editor.schema.nodes.bulletNote
  if (!entry || !noteType) return false
  const existing = noteLocation(entry)
  if (existing) {
    editor.view.dispatch(editor.state.tr
      .setSelection(TextSelection.near(editor.state.doc.resolve(existing.pos + 1)))
      .scrollIntoView())
    editor.view.focus()
    return true
  }
  const insertPos = entry.pos + 1 + (entry.node.firstChild?.nodeSize ?? 0)
  const transaction = editor.state.tr.insert(insertPos, noteType.create())
  transaction.setSelection(TextSelection.create(transaction.doc, insertPos + 1))
  editor.view.dispatch(transaction.scrollIntoView())
  editor.view.focus()
  return true
}

export function removeBulletNote(editor: Editor, nodeId: string): boolean {
  const entry = findBullet(editor.state.doc, nodeId)
  if (!entry) return false
  const note = noteLocation(entry)
  if (!note) return false
  editor.view.dispatch(editor.state.tr.delete(note.pos, note.pos + note.nodeSize))
  return true
}

function selectionIsInNote(editor: Editor): boolean {
  return editor.state.selection.$from.parent.type.name === 'bulletNote'
}

function removeEmptyActiveNote(editor: Editor): boolean {
  const { $from } = editor.state.selection
  if ($from.parent.type.name !== 'bulletNote' || $from.parent.content.size > 0) return false
  const nodeId = currentBulletId(editor)
  const entry = nodeId ? findBullet(editor.state.doc, nodeId) : null
  if (!entry) return false
  const note = noteLocation(entry)
  const title = entry.node.firstChild
  if (!note || !title) return false
  const titleEnd = entry.pos + title.nodeSize
  const transaction = editor.state.tr.delete(note.pos, note.pos + note.nodeSize)
  transaction.setSelection(TextSelection.near(transaction.doc.resolve(titleEnd)))
  editor.view.dispatch(transaction.scrollIntoView())
  editor.view.focus()
  return true
}

function stopNoteBoundaryJoin(editor: Editor, direction: 'backward' | 'forward'): boolean {
  if (!selectionIsInNote(editor) || !editor.state.selection.empty) return false
  if (removeEmptyActiveNote(editor)) return true
  const { $from } = editor.state.selection
  if (direction === 'backward') return $from.parentOffset === 0
  return $from.parentOffset === $from.parent.content.size
}

function insertNoteBreak(editor: Editor): boolean {
  return editor.commands.insertContent({ type: 'hardBreak' })
}

export const BulletNote = Node.create({
  name: 'bulletNote',
  group: 'block',
  content: 'inline*',
  defining: true,
  priority: 1_100,

  parseHTML() {
    return [{ tag: 'div[data-bullet-note]' }]
  },

  renderHTML() {
    return ['div', { 'data-bullet-note': '', class: 'bullet-note' }, 0]
  },

  addKeyboardShortcuts() {
    return {
      'Shift-Enter': () => {
        if (selectionIsInNote(this.editor)) return insertNoteBreak(this.editor)
        const nodeId = currentBulletId(this.editor)
        return nodeId ? focusOrCreateBulletNote(this.editor, nodeId) : false
      },
      Enter: () => selectionIsInNote(this.editor) && insertNoteBreak(this.editor),
      Backspace: () => stopNoteBoundaryJoin(this.editor, 'backward'),
      Delete: () => stopNoteBoundaryJoin(this.editor, 'forward'),
    }
  },
})
