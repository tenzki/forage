import { Link2, Plus } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { Editor } from '@tiptap/react'
import {
  activeInternalLinkAtSelection,
  createAndInsertInternalLink,
  insertInternalLink,
  soleInternalLinkTarget,
  type ActiveInternalLink,
} from '../../editor/internalLinks'
import { collectBullets, currentBulletId, type BulletEntry } from '../../editor/outlineModel'

interface LinkMenuState extends ActiveInternalLink {
  top: number
  left: number
}

type LinkChoice =
  | { type: 'existing'; entry: BulletEntry }
  | { type: 'create'; label: string }

function readLinkMenu(editor: Editor): LinkMenuState | null {
  const active = activeInternalLinkAtSelection(editor.state)
  if (!active) return null
  const coords = editor.view.coordsAtPos(active.to)
  return { ...active, top: coords.bottom + 4, left: coords.left }
}

function choiceKey(choice: LinkChoice): string {
  return choice.type === 'existing' ? choice.entry.id : `create:${choice.label}`
}

function canonicalEntries(entries: BulletEntry[], currentId: string | null): BulletEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]))
  const seen = new Set<string>()
  const result: BulletEntry[] = []
  for (const entry of entries) {
    const linkedTarget = soleInternalLinkTarget(entry)
    const candidate = linkedTarget ? byId.get(linkedTarget) ?? entry : entry
    if (candidate.id === currentId || seen.has(candidate.id)) continue
    seen.add(candidate.id)
    result.push(candidate)
  }
  return result
}

export function InternalLinkMenu({ editor }: { editor: Editor | null }) {
  const [menu, setMenu] = useState<LinkMenuState | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)

  useEffect(() => {
    if (!editor) return
    const update = () => {
      setMenu(readLinkMenu(editor))
      setActiveIndex(0)
    }
    editor.on('selectionUpdate', update)
    editor.on('update', update)
    return () => {
      editor.off('selectionUpdate', update)
      editor.off('update', update)
    }
  }, [editor])

  const choices = useMemo<LinkChoice[]>(() => {
    if (!editor || !menu) return []
    const query = menu.query.trim().toLocaleLowerCase()
    const currentId = currentBulletId(editor)
    const existing: LinkChoice[] = canonicalEntries(collectBullets(editor.state.doc), currentId)
      .filter((entry) => entry.text.trim().toLocaleLowerCase().includes(query))
      .slice(0, 8)
      .map((entry) => ({ type: 'existing', entry }))
    if (menu.query.trim() && !existing.some((choice) => (
      choice.type === 'existing' && choice.entry.text.trim().toLocaleLowerCase() === query
    ))) {
      existing.push({ type: 'create', label: menu.query.trim() })
    }
    return existing
  }, [editor, menu])

  useEffect(() => {
    if (!editor || !menu || !choices.length) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActiveIndex((index) => (index + 1) % choices.length)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActiveIndex((index) => (index - 1 + choices.length) % choices.length)
      } else if (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey)) {
        event.preventDefault()
        choose(choices[activeIndex])
      } else if (event.key === 'Escape') {
        event.preventDefault()
        setMenu(null)
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [editor, menu, choices, activeIndex])

  function choose(choice: LinkChoice) {
    if (!editor || !menu) return
    if (choice.type === 'existing') {
      insertInternalLink(editor, menu, choice.entry.id, choice.entry.text)
    } else {
      createAndInsertInternalLink(editor, menu, choice.label)
    }
    setMenu(null)
  }

  if (!menu || !choices.length) return null

  return (
    <ul className="internal-link-menu" style={{ top: menu.top, left: menu.left }} aria-label="Internal link suggestions">
      {choices.map((choice, index) => {
        const label = choice.type === 'existing' ? choice.entry.text.trim() || 'Untitled' : choice.label
        return (
          <li key={choiceKey(choice)}>
            <button
              type="button"
              className={index === activeIndex ? 'internal-link-item active' : 'internal-link-item'}
              onMouseDown={(event) => {
                event.preventDefault()
                choose(choice)
              }}
            >
              {choice.type === 'existing'
                ? <Link2 size={14} aria-hidden="true" />
                : <Plus size={14} aria-hidden="true" />}
              <span>{label}</span>
              <small>{choice.type === 'existing' ? 'Link to item' : 'Create linked item'}</small>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
