// The whole outliner is ONE TipTap editor. Bullets are listItems; nesting is
// real document nesting. Undo/redo is ProseMirror's native history — no Rust
// undo table, no Zustand wrapper, no debounce race. This is the structural fix
// for the undo bugs in the old per-node-editor model.

import { useEditor, EditorContent, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useEffect } from 'react'
import { useRef } from 'react'
import type { Transaction } from '@tiptap/pm/state'
import { BulletAttributes, OutlinerKeymap } from './extensions'
import { BulletNote } from './bulletNote'
import { SkillContextPreview } from './contextPreview'
import { GeneratedImage, GeneratedImageItem, OutlineBulletList } from './generatedImage'
import { InternalLink } from './internalLinks'
import { OutlinerUi } from './outlinerUi'
import { TagDecorations } from './tags'
import { SlashCommandDecorations } from './slashCommands'
import { EMPTY_DOC, normalizeOutlinerDoc } from './emptyDoc'
import type { JsonValue } from '../types/tree'
import { resolveAssetImages } from './assetImages'

interface OutlinerEditorProps {
  /** ProseMirror doc JSON to load, or null for a fresh outline. */
  initialContent: JsonValue | null
  /** Called on every doc change with the current doc JSON (caller debounces saves). */
  onDocChange: (doc: JsonValue) => void
  /** Complete root dispatch plus any normalization transactions appended to it. */
  onTransaction?: (transaction: Transaction, appendedTransactions: readonly Transaction[]) => void
  /** Receives the editor instance once ready (for slash commands, agent, search). */
  onReady?: (editor: Editor) => void
  onUndo?: (editor: Editor) => boolean
  onRedo?: (editor: Editor) => boolean
}

export function OutlinerEditor({
  initialContent,
  onDocChange,
  onTransaction,
  onReady,
  onUndo,
  onRedo,
}: OutlinerEditorProps) {
  const transactionHandler = useRef(onTransaction)
  transactionHandler.current = onTransaction
  const undoHandler = useRef(onUndo)
  const redoHandler = useRef(onRedo)
  const editorRef = useRef<Editor | null>(null)
  undoHandler.current = onUndo
  redoHandler.current = onRedo
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ bulletList: false, trailingNode: false }),
      OutlineBulletList,
      GeneratedImageItem,
      GeneratedImage,
      BulletAttributes,
      BulletNote,
      InternalLink,
      OutlinerKeymap,
      TagDecorations,
      SlashCommandDecorations,
      SkillContextPreview,
      OutlinerUi,
    ],
    content: normalizeOutlinerDoc(initialContent ?? EMPTY_DOC) as object,
    editorProps: {
      attributes: {
        autocomplete: 'off',
        autocapitalize: 'off',
        autocorrect: 'off',
        spellcheck: 'false',
      },
      handleKeyDown: (_view, event) => {
        const modifier = event.metaKey || event.ctrlKey
        if (!modifier || event.altKey || event.key.toLowerCase() !== 'z') return false
        const current = editorRef.current
        if (!current) return false
        const handled = event.shiftKey
          ? redoHandler.current?.(current) ?? false
          : undoHandler.current?.(current) ?? false
        if (handled) event.preventDefault()
        return handled
      },
    },
    onUpdate: ({ editor }) => {
      onDocChange(editor.getJSON() as JsonValue)
    },
    onTransaction: ({ transaction, appendedTransactions }) => {
      transactionHandler.current?.(transaction, appendedTransactions)
    },
  })
  editorRef.current = editor

  useEffect(() => {
    if (editor && onReady) onReady(editor)
  }, [editor, onReady])

  useEffect(() => {
    if (!editor) return
    const objectUrls = new Set<string>()
    let disposed = false
    const resolve = () => {
      if (disposed || editor.isDestroyed) return
      void resolveAssetImages(editor.view.dom)
        .then((urls) => urls.forEach((url) => objectUrls.add(url)))
    }
    const firstResolution = window.requestAnimationFrame(resolve)
    editor.on('update', resolve)
    return () => {
      disposed = true
      window.cancelAnimationFrame(firstResolution)
      editor.off('update', resolve)
      objectUrls.forEach((url) => URL.revokeObjectURL(url))
    }
  }, [editor])

  return <EditorContent editor={editor} className="outliner-editor" />
}
