import { useEffect, useRef, useState } from 'react'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { EditorState } from '@tiptap/pm/state'
import { EditorView } from '@tiptap/pm/view'
import { BulletAttributes } from '../extensions'
import { DocumentCoordinator, type DispatchResult } from './DocumentCoordinator'

/** Development-only, disposable document. Never opens the user's OutlineSession. */
export function TwoViewPrototype() {
  const left = useRef<HTMLDivElement>(null)
  const right = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState('Ready')
  useEffect(() => {
    const editor = new Editor({
      extensions: [StarterKit.configure({ undoRedo: false }), BulletAttributes],
      content: '<ul><li><p>Edit this shared bullet in either view.</p></li></ul>',
    })
    const state = editor.state.applyTransaction(editor.state.tr.insertText(' ', 3)).state
    let captures = 0
    const coordinator = new DocumentCoordinator(state, () => {
      captures++
      setStatus(`Revision ${coordinator.revision}; captured changes ${captures}`)
    })
    const recovery = (result: DispatchResult) => {
      if (!result.accepted) setStatus(`${result.reason}. Retained input: ${result.pending.doc.textContent}`)
    }
    const timers = new Set<ReturnType<typeof setTimeout>>()
    const detach: (() => void)[] = []
    const views = [left.current!, right.current!].map((element, index) => {
      const id = String(index)
      const view = new EditorView(element, {
        state: EditorState.create({ doc: state.doc, plugins: state.plugins }),
        dispatchTransaction: transaction => recovery(coordinator.dispatch(id, transaction)),
        handleDOMEvents: {
          compositionstart: () => { coordinator.beginComposition(id); return false },
          compositionend: () => {
            // Let ProseMirror flush its final composition DOM mutation first.
            const timer = setTimeout(() => {
              timers.delete(timer)
              if (!view.composing) recovery(coordinator.endComposition(id))
            }, 50)
            timers.add(timer)
            return false
          },
        },
      })
      detach.push(coordinator.attach(id, view))
      return view
    })
    return () => {
      timers.forEach(clearTimeout)
      detach.forEach(fn => fn())
      views.forEach(view => view.destroy())
      editor.destroy()
    }
  }, [])
  return <main style={{ padding: 24 }}>
    <h1>Two full-document views — disposable prototype</h1>
    <p>{status}</p>
    <p>Type in either view. During IME composition, edit the other view to exercise deferred projection.</p>
    <div style={{ display: 'flex', gap: 24 }}>
      <div ref={left} style={{ flex: 1, border: '1px solid', padding: 20 }} />
      <div ref={right} style={{ flex: 1, border: '1px solid', padding: 20 }} />
    </div>
  </main>
}
