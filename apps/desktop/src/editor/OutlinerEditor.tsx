// A full-document view adapter. App owns the canonical document/session and
// durable history; this component owns only its rendered pane and transient UI.
import { EditorContent, type Editor } from '@tiptap/react'
import { useEffect, useRef, useState } from 'react'
import { TextSelection } from '@tiptap/pm/state'
import { collectBullets } from './outlineModel'
import { resolveAssetImages } from './assetImages'
import type { DocumentCoordinator } from './DocumentCoordinator'

interface OutlinerEditorProps {
  coordinator: DocumentCoordinator
  paneId?: string
  onReady?: (editor: Editor) => void
  onUndo?: (editor: Editor) => boolean
  onRedo?: (editor: Editor) => boolean
}

export function OutlinerEditor({ coordinator, paneId = 'primary', onReady, onUndo, onRedo }: OutlinerEditorProps) {
  const undoHandler = useRef(onUndo)
  const redoHandler = useRef(onRedo)
  undoHandler.current = onUndo
  redoHandler.current = onRedo
  const [editor, setEditor] = useState<Editor | null>(null)

  useEffect(() => {
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const current = coordinator.createView(paneId, {
      editorProps: {
        attributes: { autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off',
          spellcheck: 'false', writingsuggestions: 'false' },
        handleKeyDown: (_view, event) => {
          if (!(event.metaKey || event.ctrlKey) || event.altKey || event.key.toLowerCase() !== 'z') return false
          if (event.isComposing) return false
          if (event.shiftKey) redoHandler.current?.(current)
          else undoHandler.current?.(current)
          event.preventDefault()
          return true
        },
        handleDOMEvents: {
          compositionstart: () => { coordinator.beginComposition(paneId); return false },
          compositionend: () => {
            // WebKit/ProseMirror's last DOM mutation follows compositionend.
            const timer = setTimeout(() => {
              timers.delete(timer)
              if (!current.isDestroyed && !current.view.composing) coordinator.endComposition(paneId)
            }, 50)
            timers.add(timer)
            return false
          },
          beforeinput: (_view, event) => {
            const input = event as InputEvent
            if (input.isComposing) return false
            if (input.inputType !== 'historyUndo' && input.inputType !== 'historyRedo') return false
            event.preventDefault()
            if (input.inputType === 'historyRedo') redoHandler.current?.(current)
            else undoHandler.current?.(current)
            return true
          },
          mousedown: (view, event) => {
            if (event.target !== view.dom) return false
            const editable = collectBullets(view.state.doc).slice().reverse()
              .find(entry => entry.systemRole === null)
            if (!editable) return false
            event.preventDefault()
            view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, editable.pos + 2)))
            view.focus()
            return true
          },
        },
      },
    })
    const bullets = collectBullets(current.state.doc)
    const trailing = bullets[bullets.length - 1]
    if (trailing && trailing.systemRole === null && !trailing.text && !trailing.noteText) {
      current.commands.setTextSelection(trailing.pos + 2)
    }
    setEditor(current)
    return () => {
      timers.forEach(clearTimeout)
      current.destroy()
    }
  }, [coordinator, paneId])

  useEffect(() => { if (editor && !editor.isDestroyed) onReady?.(editor) }, [editor, onReady])

  useEffect(() => {
    if (!editor) return
    const objectUrls = new Set<string>()
    let disposed = false
    const resolve = () => {
      if (disposed || editor.isDestroyed) return
      void resolveAssetImages(editor.view.dom).then(urls => urls.forEach(url => {
        if (disposed) URL.revokeObjectURL(url)
        else objectUrls.add(url)
      }))
    }
    const firstResolution = window.requestAnimationFrame(resolve)
    editor.on('update', resolve)
    return () => {
      disposed = true
      window.cancelAnimationFrame(firstResolution)
      editor.off('update', resolve)
      objectUrls.forEach(url => URL.revokeObjectURL(url))
    }
  }, [editor])

  return <EditorContent editor={editor?.isDestroyed ? null : editor} className="outliner-editor" />
}
