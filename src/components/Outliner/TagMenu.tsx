import { useEffect, useMemo, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { activeTagAtSelection, collectTags, type ActiveTag } from '../../editor/tags'

interface TagMenuState extends ActiveTag {
  top: number
  left: number
}

function readTagMenu(editor: Editor): TagMenuState | null {
  const active = activeTagAtSelection(editor.state)
  if (!active) return null
  const coords = editor.view.coordsAtPos(active.to)
  return { ...active, top: coords.bottom + 4, left: coords.left }
}

export function TagMenu({ editor }: { editor: Editor | null }) {
  const [menu, setMenu] = useState<TagMenuState | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)

  useEffect(() => {
    if (!editor) return
    const update = () => {
      setMenu(readTagMenu(editor))
      setActiveIndex(0)
    }
    editor.on('selectionUpdate', update)
    editor.on('update', update)
    return () => {
      editor.off('selectionUpdate', update)
      editor.off('update', update)
    }
  }, [editor])

  const matches = useMemo(() => {
    if (!editor || !menu) return []
    return collectTags(editor.state.doc)
      .filter((tag) => tag.startsWith(menu.query))
      .slice(0, 8)
  }, [editor, menu])

  useEffect(() => {
    if (!editor || !menu || !matches.length) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActiveIndex((index) => (index + 1) % matches.length)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActiveIndex((index) => (index - 1 + matches.length) % matches.length)
      } else if (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey)) {
        event.preventDefault()
        completeTag(matches[activeIndex])
      } else if (event.key === 'Escape') {
        event.preventDefault()
        setMenu(null)
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [editor, menu, matches, activeIndex])

  function completeTag(tag: string) {
    if (!editor || !menu) return
    editor.chain()
      .focus()
      .insertContentAt({ from: menu.from, to: menu.to }, `#${tag} `)
      .run()
    setMenu(null)
  }

  if (!menu || !matches.length) return null

  return (
    <ul className="tag-menu" style={{ top: menu.top, left: menu.left }} aria-label="Tag suggestions">
      {matches.map((tag, index) => (
        <li key={tag}>
          <button
            type="button"
            className={index === activeIndex ? 'tag-item active' : 'tag-item'}
            onMouseDown={(event) => {
              event.preventDefault()
              completeTag(tag)
            }}
          >
            <span>#{tag}</span>
            <small>{tag === menu.query ? 'Complete tag' : 'Existing tag'}</small>
          </button>
        </li>
      ))}
    </ul>
  )
}
