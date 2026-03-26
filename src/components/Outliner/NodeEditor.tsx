import { useEffect, useRef } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import { Extension } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import type { TreeNode } from '../../types/tree'
import { useTreeStore } from '../../store/treeStore'
import { HashtagNode } from '../../extensions/HashtagNode'

interface OutlinerKeysOptions {
  onEnter: () => void
  onIndent: () => void
  onOutdent: () => void
  onDeleteEmpty: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  onMoveLeft: () => void
  onMoveRight: () => void
  onFocusPrev: () => void
  onFocusNext: () => void
  onSelectRangeUp: () => void
  onSelectRangeDown: () => void
  hasSelection: () => boolean
  onBatchIndent: () => void
  onBatchOutdent: () => void
  onBatchDelete: () => void
  onUndo: () => void
  onRedo: () => void
}

/**
 * TipTap extension providing Workflowy-style keyboard shortcuts.
 * All handlers are passed as options to avoid stale closure issues.
 */
const OutlinerKeys = Extension.create<OutlinerKeysOptions>({
  name: 'outlinerKeys',

  addOptions() {
    return {
      onEnter: () => {},
      onIndent: () => {},
      onOutdent: () => {},
      onDeleteEmpty: () => {},
      onMoveUp: () => {},
      onMoveDown: () => {},
      onMoveLeft: () => {},
      onMoveRight: () => {},
      onFocusPrev: () => {},
      onFocusNext: () => {},
      onSelectRangeUp: () => {},
      onSelectRangeDown: () => {},
      hasSelection: () => false,
      onBatchIndent: () => {},
      onBatchOutdent: () => {},
      onBatchDelete: () => {},
      onUndo: () => {},
      onRedo: () => {},
    }
  },

  addKeyboardShortcuts() {
    const opts = this.options

    return {
      Enter: () => {
        opts.onEnter()
        return true // Prevent TipTap from inserting a paragraph
      },

      Tab: () => {
        if (opts.hasSelection()) {
          opts.onBatchIndent()
        } else {
          opts.onIndent()
        }
        return true // Prevent browser focus traversal
      },

      'Shift-Tab': () => {
        if (opts.hasSelection()) {
          opts.onBatchOutdent()
        } else {
          opts.onOutdent()
        }
        return true // Prevent browser Shift-Tab behavior
      },

      Backspace: ({ editor }) => {
        if (opts.hasSelection()) {
          opts.onBatchDelete()
          return true
        }
        if (editor.isEmpty) {
          opts.onDeleteEmpty()
          return true
        }
        return false // Allow normal backspace for non-empty nodes
      },

      'Alt-ArrowUp': () => {
        opts.onMoveUp()
        return true
      },

      'Alt-ArrowDown': () => {
        opts.onMoveDown()
        return true
      },

      'Alt-ArrowLeft': () => {
        if (opts.hasSelection()) {
          opts.onBatchOutdent()
        } else {
          opts.onMoveLeft()
        }
        return true
      },

      'Alt-ArrowRight': () => {
        if (opts.hasSelection()) {
          opts.onBatchIndent()
        } else {
          opts.onMoveRight()
        }
        return true
      },

      ArrowUp: () => {
        opts.onFocusPrev()
        return true
      },

      ArrowDown: () => {
        opts.onFocusNext()
        return true
      },

      'Shift-ArrowUp': () => {
        opts.onSelectRangeUp()
        return true // Prevent cursor movement
      },

      'Shift-ArrowDown': () => {
        opts.onSelectRangeDown()
        return true // Prevent cursor movement
      },
      // Mod-z and Mod-Shift-z are intentionally NOT handled here.
      // App.tsx registers a capture-phase keydown handler that fires undo/redo
      // globally before TipTap receives the event. Handling them here would
      // cause undo() to fire twice per keypress.
    }
  },
})

interface NodeEditorProps {
  node: TreeNode
}

/**
 * TipTap inline editor for a single outliner node.
 * Only mounted for the currently editing node — all others render plain text.
 * Registers all Workflowy-style keyboard shortcuts via OutlinerKeys extension.
 */
export default function NodeEditor({ node }: NodeEditorProps) {
  const createNode = useTreeStore((s) => s.createNode)
  const deleteNode = useTreeStore((s) => s.deleteNode)
  const updateContent = useTreeStore((s) => s.updateContent)
  const indentNode = useTreeStore((s) => s.indentNode)
  const outdentNode = useTreeStore((s) => s.outdentNode)
  const reorderNode = useTreeStore((s) => s.reorderNode)
  const selectRange = useTreeStore((s) => s.selectRange)
  const clearSelection = useTreeStore((s) => s.clearSelection)
  const batchIndent = useTreeStore((s) => s.batchIndent)
  const batchOutdent = useTreeStore((s) => s.batchOutdent)
  const batchDelete = useTreeStore((s) => s.batchDelete)
  const selectedNodeIds = useTreeStore((s) => s.selectedNodeIds)
  const setEditingNode = useTreeStore((s) => s.setEditingNode)
  const focusPrevNode = useTreeStore((s) => s.focusPrevNode)
  const focusNextNode = useTreeStore((s) => s.focusNextNode)
  const undo = useTreeStore((s) => s.undo)
  const redo = useTreeStore((s) => s.redo)
  const onTagClick = useTreeStore((s) => s.onTagClick)

  // Track whether a content change originated from the editor (typing) vs externally (undo)
  const isInternalUpdate = useRef(false)

  // Use refs for callbacks to avoid stale closures in extension
  const nodeRef = useRef(node)
  nodeRef.current = node

  const selectedIdsRef = useRef(selectedNodeIds)
  selectedIdsRef.current = selectedNodeIds

  // Use ref for onTagClick to avoid stale closures in extension
  const onTagClickRef = useRef(onTagClick)
  onTagClickRef.current = onTagClick

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        undoRedo: false, // Disabled: App.tsx capture-phase handler manages undo/redo globally
        heading: false,
        blockquote: false,
        codeBlock: false,
        horizontalRule: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
      }),
      HashtagNode.configure({
        onTagClick: (tag: string) => {
          onTagClickRef.current?.(tag)
        },
      }),
      OutlinerKeys.configure({
        onEnter: () => {
          const n = nodeRef.current
          createNode(n.parent_id, n.id).catch(console.error)
        },

        onIndent: () => {
          indentNode(nodeRef.current.id).catch(console.error)
        },

        onOutdent: () => {
          outdentNode(nodeRef.current.id).catch(console.error)
        },

        onDeleteEmpty: () => {
          deleteNode(nodeRef.current.id).catch(console.error)
        },

        onMoveUp: () => {
          reorderNode(nodeRef.current.id, 'up').catch(console.error)
        },

        onMoveDown: () => {
          reorderNode(nodeRef.current.id, 'down').catch(console.error)
        },

        onMoveLeft: () => {
          outdentNode(nodeRef.current.id).catch(console.error)
        },

        onMoveRight: () => {
          indentNode(nodeRef.current.id).catch(console.error)
        },

        onFocusPrev: () => {
          focusPrevNode(nodeRef.current.id)
        },

        onFocusNext: () => {
          focusNextNode(nodeRef.current.id)
        },

        onSelectRangeUp: () => {
          selectRange(nodeRef.current.id, 'up')
        },

        onSelectRangeDown: () => {
          selectRange(nodeRef.current.id, 'down')
        },

        hasSelection: () => selectedIdsRef.current.size > 0,

        onBatchIndent: () => {
          batchIndent().catch(console.error)
        },

        onBatchOutdent: () => {
          batchOutdent().catch(console.error)
        },

        onBatchDelete: () => {
          batchDelete().catch(console.error)
        },

        onUndo: () => {
          undo().catch(console.error)
        },

        onRedo: () => {
          redo().catch(console.error)
        },
      }),
    ],
    content: node.content as object,
    onUpdate: ({ editor }) => {
      // Skip store update when content was set externally (undo/redo sync)
      if (isInternalUpdate.current) {
        isInternalUpdate.current = false
        return
      }
      updateContent(nodeRef.current.id, editor.getJSON() as unknown as import('../../lib/bindings').JsonValue)
    },
    onBlur: () => {
      clearSelection()
      setEditingNode(null)
    },
    autofocus: 'end',
    editorProps: {
      attributes: {
        class: 'node-editor-content',
        'data-node-id': node.id,
        autocomplete: 'off',
        autocorrect: 'off',
        autocapitalize: 'off',
        spellcheck: 'false',
      },
      handleKeyDown: (_view, event) => {
        // Stop ALL key events from bubbling to react-arborist.
        // react-arborist intercepts characters (type-ahead), Enter, arrows, etc.
        // TipTap/ProseMirror already processed the event at this point.
        event.stopPropagation()
        // Prevent browser Tab focus traversal
        if (event.key === 'Tab') {
          event.preventDefault()
        }
      },
    },
  })

  // Auto-focus the editor when it mounts
  useEffect(() => {
    if (editor && !editor.isFocused) {
      editor.commands.focus('end')
    }
  }, [editor])

  // Sync external content changes (e.g. undo/redo) into the TipTap editor.
  // TipTap manages its own internal state, so store changes from loadTree()
  // don't automatically appear. Uses a single ProseMirror transaction to
  // replace content AND set cursor position atomically.
  useEffect(() => {
    if (editor && node.content) {
      const editorJson = JSON.stringify(editor.getJSON())
      const storeJson = JSON.stringify(node.content)
      if (editorJson !== storeJson) {
        // Flag tells onUpdate to skip updateContent for this setContent call
        isInternalUpdate.current = true
        editor.commands.setContent(node.content as object)
      }
    }
  }, [editor, node.content])

  return (
    <div className="node-editor" onKeyDown={(e) => {
      // Redundant safety net — stop any key events that escape ProseMirror's handleKeyDown
      e.stopPropagation()
      if (e.key === 'Tab') {
        e.preventDefault()
      }
    }}>
      <EditorContent editor={editor} />
    </div>
  )
}
