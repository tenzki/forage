import { Plus } from 'lucide-react'
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
  | { type: 'existing'; entry: BulletEntry; path: string }
  | { type: 'create'; label: string }

/** Where a bullet lives, as its nearest ancestor titles (`Link Picker/Option`). */
function bulletPath(entry: BulletEntry, titles: Map<string, string>): string {
  const ancestors = entry.ancestorIds.map((id) => titles.get(id)?.trim() || 'Untitled')
  if (!ancestors.length) return 'Home'
  return ancestors.slice(-2).join(' › ')
}

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
    const entries = collectBullets(editor.state.doc)
    const titles = new Map(entries.map((entry) => [entry.id, entry.text]))
    const existing: LinkChoice[] = canonicalEntries(entries, currentId)
      .filter((entry) => entry.text.trim().toLocaleLowerCase().includes(query))
      .slice(0, 8)
      .map((entry) => ({ type: 'existing', entry, path: bulletPath(entry, titles) }))
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

  const matchCount = choices.filter((choice) => choice.type === 'existing').length
  return (
    <div className="internal-link-menu t-dropdown is-open" data-origin="top-left" style={{ top: menu.top, left: menu.left }}>
      <div className="internal-link-query" aria-hidden="true">
        <span className="internal-link-query-brackets">[[</span>
        <span className="internal-link-query-text">{menu.query || 'Link to a bullet'}</span>
        <span className="internal-link-query-count">{matchCount} {matchCount === 1 ? 'match' : 'matches'}</span>
      </div>
      <ul aria-label="Internal link suggestions">
        {choices.map((choice, index) => (
          <li key={choiceKey(choice)} className={choice.type === 'create' && matchCount > 0 ? 'has-divider' : undefined}>
            <button
              type="button"
              className={index === activeIndex ? 'internal-link-item active' : 'internal-link-item'}
              onMouseDown={(event) => {
                event.preventDefault()
                choose(choice)
              }}
            >
              {choice.type === 'existing' ? (
                <>
                  <span className="internal-link-glyph" aria-hidden="true" />
                  <span className="internal-link-copy">
                    <span className="internal-link-title">{choice.entry.text.trim() || 'Untitled'}</span>
                    <small>{choice.path}</small>
                  </span>
                </>
              ) : (
                <>
                  <Plus size={14} aria-hidden="true" />
                  <span className="internal-link-create">Create bullet “{choice.label}”</span>
                  <small>at top level</small>
                </>
              )}
            </button>
          </li>
        ))}
      </ul>
      <div className="internal-link-footer" aria-hidden="true">
        <span><kbd>↑↓</kbd> move</span>
        <span><kbd>tab</kbd> link</span>
        <span><kbd>esc</kbd> close</span>
      </div>
    </div>
  )
}
