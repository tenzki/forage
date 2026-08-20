// The whole outliner is ONE TipTap editor. Bullets are listItems; nesting is
// real document nesting. Undo/redo is ProseMirror's native history — no Rust
// undo table, no Zustand wrapper, no debounce race. This is the structural fix
// for the undo bugs in the old per-node-editor model.

import { useEditor, EditorContent, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useEffect } from 'react'
import { BulletAttributes, OutlinerKeymap } from './extensions'
import { BulletNote } from './bulletNote'
import { OutlinerUi } from './outlinerUi'
import { TagDecorations } from './tags'
import { SlashCommandDecorations } from './slashCommands'
import { EMPTY_DOC } from './emptyDoc'
import type { JsonValue } from '../types/tree'

interface OutlinerEditorProps {
  /** ProseMirror doc JSON to load, or null for a fresh outline. */
  initialContent: JsonValue | null
  /** Called on every doc change with the current doc JSON (caller debounces saves). */
  onDocChange: (doc: JsonValue) => void
  /** Receives the editor instance once ready (for slash commands, agent, search). */
  onReady?: (editor: Editor) => void
}

export function OutlinerEditor({
  initialContent,
  onDocChange,
  onReady,
}: OutlinerEditorProps) {
  const editor = useEditor({
    extensions: [
      StarterKit, // bulletList, listItem, paragraph, marks, history (undo/redo)
      BulletAttributes,
      BulletNote,
      OutlinerKeymap,
      TagDecorations,
      SlashCommandDecorations,
      OutlinerUi,
    ],
    content: (initialContent ?? EMPTY_DOC) as object,
    onUpdate: ({ editor }) => {
      onDocChange(editor.getJSON() as JsonValue)
    },
  })

  useEffect(() => {
    if (editor && onReady) onReady(editor)
  }, [editor, onReady])

  return <EditorContent editor={editor} className="outliner-editor" />
}
