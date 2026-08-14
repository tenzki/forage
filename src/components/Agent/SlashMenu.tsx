// Slash-command menu. When the current bullet's text starts with "/", show
// matching skills near the caret. Selecting one completes "/skill " so the
// user can add context; Enter then runs it. Esc dismisses.
//
// No false positives on mid-sentence slashes: we only trigger when the bullet
// text *starts* with "/" (AGNT-01).

import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { SKILLS, type Skill } from '../../agent/skills'
import {
  runSkillIntoEditor,
  setCurrentBulletText,
  type Generation,
} from '../../agent/insertIntoEditor'
import { useSettingsStore } from '../../store/settingsStore'

interface MenuState {
  query: string
  prompt: string
  top: number
  left: number
}

function readSlashState(editor: Editor): MenuState | null {
  const { $from, empty } = editor.state.selection
  if (!empty) return null
  // current listItem's paragraph text
  let text = ''
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === 'listItem') {
      text = $from.node(d).firstChild?.textContent ?? ''
      break
    }
  }
  if (!text.startsWith('/')) return null
  const body = text.slice(1)
  const spaceIdx = body.indexOf(' ')
  const query = spaceIdx === -1 ? body : body.slice(0, spaceIdx)
  const prompt = spaceIdx === -1 ? '' : body.slice(spaceIdx + 1)
  const coords = editor.view.coordsAtPos($from.pos)
  return { query, prompt, top: coords.bottom + 4, left: coords.left }
}

export function SlashMenu({ editor }: { editor: Editor | null }) {
  const authMode = useSettingsStore((s) => s.authMode)
  const openAiApiKey = useSettingsStore((s) => s.openAiApiKey)
  const oauthCredential = useSettingsStore((s) => s.oauthCredential)
  const modelId = useSettingsStore((s) => s.modelId)
  const setOAuthCredential = useSettingsStore((s) => s.setOAuthCredential)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [active, setActive] = useState(0)
  const genRef = useRef<Generation | null>(null)

  // Track editor changes to open/close the menu.
  useEffect(() => {
    if (!editor) return
    const update = () => {
      const state = readSlashState(editor)
      setMenu(state)
      setActive(0)
    }
    editor.on('selectionUpdate', update)
    editor.on('update', update)
    return () => {
      editor.off('selectionUpdate', update)
      editor.off('update', update)
    }
  }, [editor])

  const matches: Skill[] = menu
    ? SKILLS.filter((s) => s.label.startsWith(menu.query))
    : []

  // Keyboard handling while menu is open (capture beats the editor's handlers).
  useEffect(() => {
    if (!editor || !menu || matches.length === 0) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActive((i) => (i + 1) % matches.length)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((i) => (i - 1 + matches.length) % matches.length)
      } else if (e.key === 'Tab' && !e.shiftKey) {
        e.preventDefault()
        complete(matches[active])
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const skill = matches[active]
        const hasContext = menu.query === skill.label && menu.prompt.trim().length > 0
        if (hasContext || e.metaKey || e.ctrlKey) run(skill)
        else complete(skill)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        setMenu(null)
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [editor, menu, matches, active])

  function complete(skill: Skill) {
    if (!editor) return
    const context = menu?.prompt.trimStart() ?? ''
    const command = `/${skill.label}${context ? ` ${context}` : ' '}`
    setCurrentBulletText(editor, command, true)
    editor.view.focus()
  }

  function run(skill: Skill) {
    if (!editor) return
    const prompt = (menu?.prompt || skill.label).trim()
    // Replace the command with its context so the bullet remains a clean note.
    setCurrentBulletText(editor, prompt)
    setMenu(null)
    genRef.current?.cancel()
    genRef.current = runSkillIntoEditor(
      editor,
      {
        mode: authMode,
        apiKey: openAiApiKey,
        oauthCredential,
        modelId,
        onCredentialRefresh: setOAuthCredential,
      },
      skill,
      prompt,
    )
  }

  if (!menu || matches.length === 0) return null

  return (
    <ul className="slash-menu" style={{ top: menu.top, left: menu.left }}>
      {matches.map((s, i) => (
        <li
          key={s.id}
          className={i === active ? 'slash-item active' : 'slash-item'}
          onMouseDown={(e) => {
            e.preventDefault()
            complete(s)
          }}
        >
          <span className="slash-label">/{s.label}</span>
          <span className="slash-desc">
            {menu.query === s.label && menu.prompt.trim()
              ? 'Press Enter to run with this context'
              : `${s.description} · Enter or Tab to select`}
          </span>
        </li>
      ))}
    </ul>
  )
}
