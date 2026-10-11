import type { Editor } from '@tiptap/core'

// Weak origins remain resolvable after view detachment for already-admitted work.
const documents = new WeakMap<Editor, Editor>()
const panes = new WeakMap<Editor, string>()
export function registerDocumentEditor(view: Editor, document: Editor, paneId?: string): void {
  documents.set(view, document)
  if (paneId) panes.set(view, paneId)
}
export function editorPaneId(view: Editor): string | undefined { return panes.get(view) }
export function ownsPaneEvent(editor: Editor, detail: { sourcePaneId?: string } | undefined, active = true): boolean {
  return detail?.sourcePaneId ? detail.sourcePaneId === editorPaneId(editor) : active
}
export function documentEditor(view: Editor): Editor {
  return documents.get(view) ?? view
}
