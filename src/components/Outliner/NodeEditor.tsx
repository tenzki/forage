import { useEffect, useRef } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import { Extension } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import type { TreeNode } from '../../types/tree'
import { useTreeStore } from '../../store/treeStore'

interface OutlinerKeysOptions {
  onEnter: () => void
  onIndent: () => void
  onOutdent: () => void
  onDeleteEmpty: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  onMoveLeft: () => void
  onMoveRight: () => void
  onSelectRangeUp: () => void
  onSelectRangeDown: () => void
  hasSelection: () => boolean
  onBatchIndent: () => void
  onBatchOutdent: () => void
  onBatchDelete: () => void
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
      onSelectRangeUp: () => {},
      onSelectRangeDown: () => {},
      hasSelection: () => false,
      onBatchIndent: () => {},
      onBatchOutdent: () => {},
      onBatchDelete: () => {},
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
        opts.onMoveLeft()
        return true
      },

      'Alt-ArrowRight': () => {
        opts.onMoveRight()
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

  // Use refs for callbacks to avoid stale closures in extension
  const nodeRef = useRef(node)
  nodeRef.current = node

  const selectedIdsRef = useRef(selectedNodeIds)
  selectedIdsRef.current = selectedNodeIds

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        blockquote: false,
        codeBlock: false,
        horizontalRule: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
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
      }),
    ],
    content: node.content as object,
    onUpdate: ({ editor }) => {
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
      },
    },
  })

  // Auto-focus the editor when it mounts
  useEffect(() => {
    if (editor && !editor.isFocused) {
      editor.commands.focus('end')
    }
  }, [editor])

  return (
    <div className="node-editor">
      <EditorContent editor={editor} />
    </div>
  )
}
