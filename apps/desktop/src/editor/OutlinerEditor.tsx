// The whole outliner is ONE TipTap editor. Bullets are listItems and nesting is
// real document nesting. Durable compensating events are the sole undo/redo
// authority, so StarterKit's in-memory history must stay disabled.

import { useEditor, EditorContent, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { useEffect } from 'react'
import { useRef } from 'react'
import { TextSelection, type Transaction } from '@tiptap/pm/state'
import { BulletAttributes, OutlinerKeymap } from './extensions'
import { BulletNote } from './bulletNote'
import { SkillContextPreview } from './contextPreview'
import { GeneratedImage, GeneratedImageItem, OutlineBulletList, OutlineListItem } from './generatedImage'
import { InternalLink } from './internalLinks'
import { OutlinerUi } from './outlinerUi'
import { TagDecorations } from './tags'
import { SlashCommandDecorations } from './slashCommands'
import { EMPTY_DOC, normalizeOutlinerDoc } from './emptyDoc'
import { collectBullets } from './outlineModel'
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
  const content = normalizeOutlinerDoc(initialContent ?? EMPTY_DOC)
  undoHandler.current = onUndo
  redoHandler.current = onRedo
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        bulletList: false,
        listItem: false,
        trailingNode: false,
        undoRedo: false,
      }),
      OutlineListItem,
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
    content: content as object,
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
        if (event.shiftKey) {
          redoHandler.current?.(current)
        } else {
          undoHandler.current?.(current)
        }
        // Never let Mod-Z fall through to the browser or another history
        // implementation, even when the durable stack is exhausted.
        event.preventDefault()
        return true
      },
      handleDOMEvents: {
        mousedown: (view, event) => {
          if (event.target !== view.dom) return false
          const editable = collectBullets(view.state.doc)
            .slice()
            .reverse()
            .find((entry) => entry.systemRole === null)
          if (!editable) return false
          event.preventDefault()
          view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, editable.pos + 2)))
          view.focus()
          return true
        },
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
    if (!editor) return
    const bullets = collectBullets(editor.state.doc)
    const trailing = bullets[bullets.length - 1]
    if (
      trailing
      && trailing.systemRole === null
      && trailing.text.length === 0
      && trailing.noteText.length === 0
    ) {
      editor.commands.setTextSelection(trailing.pos + 2)
    }
  }, [editor])

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
