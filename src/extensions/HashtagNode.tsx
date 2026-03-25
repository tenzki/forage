import { Node, mergeAttributes } from '@tiptap/core'
import { ReactNodeViewRenderer, NodeViewWrapper } from '@tiptap/react'
import type { NodeViewProps } from '@tiptap/react'
import Suggestion from '@tiptap/suggestion'
import { createPortal } from 'react-dom'
import { useState, useEffect, useCallback, useRef } from 'react'
import { getTagsMatchingIpc } from '../store/ipc'

// ─── Suggestion Popup ─────────────────────────────────────────────────────────

interface SuggestionPopupProps {
  items: string[]
  command: (item: string) => void
  clientRect: (() => DOMRect | null) | null
}

function SuggestionPopup({ items, command, clientRect }: SuggestionPopupProps) {
  const [selectedIndex, setSelectedIndex] = useState(0)

  const rect = clientRect?.()

  const selectItem = useCallback(
    (index: number) => {
      const item = items[index]
      if (item) {
        command(item)
      }
    },
    [items, command]
  )

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((i) => (i + 1) % Math.max(items.length, 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((i) => (i - 1 + Math.max(items.length, 1)) % Math.max(items.length, 1))
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        selectItem(selectedIndex)
        return
      }
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [items, selectedIndex, selectItem])

  useEffect(() => {
    setSelectedIndex(0)
  }, [items])

  if (!rect || items.length === 0) return null

  const style: React.CSSProperties = {
    position: 'fixed',
    top: rect.bottom + 4,
    left: rect.left,
    zIndex: 1001,
  }

  return createPortal(
    <div className="suggestion-popup" style={style}>
      {items.map((item, index) => (
        <div
          key={item}
          className={`suggestion-item${index === selectedIndex ? ' suggestion-item--active' : ''}`}
          onMouseDown={(e) => {
            e.preventDefault()
            selectItem(index)
          }}
        >
          #{item}
        </div>
      ))}
    </div>,
    document.body
  )
}

// ─── Node View ────────────────────────────────────────────────────────────────

interface HashtagNodeViewProps extends NodeViewProps {
  extension: {
    options: HashtagNodeOptions
  }
}

function HashtagNodeView({ node, extension }: HashtagNodeViewProps) {
  const tag = node.attrs.tag as string

  const handleClick = () => {
    if (extension.options.onTagClick) {
      extension.options.onTagClick(tag)
    }
  }

  return (
    <NodeViewWrapper as="span" style={{ display: 'inline' }}>
      <span
        className="hashtag"
        data-hashtag={tag}
        onClick={handleClick}
        contentEditable={false}
      >
        #{tag}
      </span>
    </NodeViewWrapper>
  )
}

// ─── Extension Options ────────────────────────────────────────────────────────

export interface HashtagNodeOptions {
  onTagClick?: (tag: string) => void
  HTMLAttributes: Record<string, unknown>
}

// Module-level state for the suggestion popup
let suggestionPopupRef: {
  setProps: (props: SuggestionPopupProps | null) => void
} | null = null

// Rendered popup component host
let popupContainer: HTMLDivElement | null = null

function getOrCreatePopupContainer(): HTMLDivElement {
  if (!popupContainer) {
    popupContainer = document.createElement('div')
    popupContainer.id = 'hashtag-suggestion-portal'
    document.body.appendChild(popupContainer)
  }
  return popupContainer
}

// ─── HashtagNode Extension ────────────────────────────────────────────────────

export const HashtagNode = Node.create<HashtagNodeOptions>({
  name: 'hashtag',

  group: 'inline',
  inline: true,
  selectable: false,
  atom: true,

  addOptions() {
    return {
      onTagClick: undefined,
      HTMLAttributes: {},
    }
  },

  addAttributes() {
    return {
      tag: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-hashtag'),
        renderHTML: (attributes) => {
          if (!attributes.tag) return {}
          return { 'data-hashtag': attributes.tag }
        },
      },
    }
  },

  parseHTML() {
    return [{ tag: 'span[data-hashtag]' }]
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(
        { 'data-hashtag': node.attrs.tag, class: 'hashtag' },
        HTMLAttributes
      ),
      '#' + node.attrs.tag,
    ]
  },

  addNodeView() {
    return ReactNodeViewRenderer(HashtagNodeView)
  },

  addProseMirrorPlugins() {
    const extensionThis = this

    // Popup state
    let currentProps: SuggestionPopupProps | null = null
    let popupRoot: import('react-dom/client').Root | null = null

    function renderPopup(props: SuggestionPopupProps | null) {
      currentProps = props

      if (typeof window === 'undefined') return

      // Lazy import react-dom/client to avoid SSR issues
      import('react-dom/client').then(({ createRoot }) => {
        const container = getOrCreatePopupContainer()

        if (!popupRoot) {
          popupRoot = createRoot(container)
        }

        if (props) {
          popupRoot.render(<SuggestionPopup {...props} />)
        } else {
          popupRoot.render(null)
        }
      })
    }

    return [
      Suggestion({
        editor: this.editor,
        char: '#',
        startOfLine: false,
        allowSpaces: false,
        allowedPrefixes: null,

        items: async ({ query }) => {
          if (query.length < 2) return []
          try {
            return await getTagsMatchingIpc(query)
          } catch {
            return []
          }
        },

        command: ({ editor, range, props: tag }) => {
          editor
            .chain()
            .focus()
            .deleteRange(range)
            .insertContent({ type: 'hashtag', attrs: { tag } })
            .run()
        },

        render: () => {
          let clientRectFn: (() => DOMRect | null) | null = null
          let currentCommand: ((item: string) => void) | null = null
          let currentItems: string[] = []

          return {
            onStart: (props) => {
              clientRectFn = props.clientRect
              currentItems = props.items as string[]
              currentCommand = props.command as unknown as (item: string) => void

              renderPopup({
                items: currentItems,
                command: (item) => currentCommand?.(item),
                clientRect: clientRectFn,
              })
            },

            onUpdate: (props) => {
              clientRectFn = props.clientRect
              currentItems = props.items as string[]
              currentCommand = props.command as unknown as (item: string) => void

              renderPopup({
                items: currentItems,
                command: (item) => currentCommand?.(item),
                clientRect: clientRectFn,
              })
            },

            onKeyDown: ({ event }) => {
              // Arrow keys and Enter are handled in SuggestionPopup's own keydown handler
              if (event.key === 'Escape') {
                renderPopup(null)
                return true
              }
              if (currentItems.length > 0 && (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter')) {
                return true
              }
              return false
            },

            onExit: () => {
              renderPopup(null)
            },
          }
        },
      }),
    ]
  },
})

export default HashtagNode
