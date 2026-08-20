// Slash-command menu. When the current bullet's text starts with "/", show
// matching skills near the caret. Selecting one completes "/skill " so the
// user can add context; Enter then runs it. Esc dismisses.
//
// No false positives on mid-sentence slashes: we only trigger when the bullet
// text *starts* with "/" (AGNT-01).

import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import { SKILLS, type Skill } from '../../agent/skills'
import { focusOrCreateBulletNote } from '../../editor/bulletNote'
import {
  OUTLINE_COMMANDS,
  type OutlineCommandDefinition,
} from '../../editor/commandDefinitions'
import {
  currentBulletId,
  setBulletKind,
  setTodoCompleted,
} from '../../editor/outlineModel'
import {
  runSkillIntoEditor,
  setCurrentBulletText,
} from '../../agent/insertIntoEditor'
import { useSettingsStore } from '../../store/settingsStore'

interface CommandChoice {
  id: string
  label: string
  description: string
  skill?: Skill
  outlineCommand?: OutlineCommandDefinition
}

const COMMAND_CHOICES: CommandChoice[] = [
  ...OUTLINE_COMMANDS.map((outlineCommand) => ({
    ...outlineCommand,
    outlineCommand,
  })),
  ...SKILLS.map((skill) => ({
    id: skill.id,
    label: skill.label,
    description: skill.description,
    skill,
  })),
]

interface MenuState {
  query: string
  prompt: string
  top: number
  left: number
}

function runOutlineCommand(editor: Editor, command: OutlineCommandDefinition): void {
  const nodeId = currentBulletId(editor)
  if (!nodeId) return
  if (command.id === 'note') {
    focusOrCreateBulletNote(editor, nodeId)
    return
  }
  if (command.id === 'bullet') {
    setBulletKind(editor, nodeId, 'bullet')
    return
  }
  setTodoCompleted(editor, nodeId, command.id === 'done')
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
  const enabledToolIds = useSettingsStore((s) => s.enabledToolIds)
  const customTools = useSettingsStore((s) => s.customTools)
  const setOAuthCredential = useSettingsStore((s) => s.setOAuthCredential)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [active, setActive] = useState(0)
  const [completedCommand, setCompletedCommand] = useState<CommandChoice | null>(null)
  const completedCommandRef = useRef<CommandChoice | null>(null)

  // Track editor changes to open/close the menu.
  useEffect(() => {
    if (!editor) return
    const update = () => {
      const state = readSlashState(editor)
      const completed = completedCommandRef.current
      if (completed && state?.query === completed.label) {
        setMenu(null)
        return
      }
      if (completed) {
        completedCommandRef.current = null
        setCompletedCommand(null)
      }
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

  const matches: CommandChoice[] = menu
    ? COMMAND_CHOICES.filter((command) => command.label.startsWith(menu.query))
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
        if (skill.outlineCommand || hasContext || e.metaKey || e.ctrlKey) run(skill)
        else complete(skill)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        setMenu(null)
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [editor, menu, matches, active])

  useEffect(() => {
    if (!editor || !completedCommand) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
      const state = readSlashState(editor)
      if (state?.query !== completedCommand.label) return
      event.preventDefault()
      run(completedCommand)
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [editor, completedCommand])

  function complete(command: CommandChoice) {
    if (!editor) return
    const context = menu?.prompt.trimStart() ?? ''
    const text = `/${command.label}${context ? ` ${context}` : ' '}`
    completedCommandRef.current = command
    setCompletedCommand(command)
    setCurrentBulletText(editor, text, true)
    setMenu(null)
    editor.view.focus()
  }

  function run(command: CommandChoice) {
    if (!editor) return
    const state = readSlashState(editor)
    const context = state?.query === command.label ? state.prompt : menu?.prompt
    const prompt = (context || (command.skill ? command.label : '')).trim()
    completedCommandRef.current = null
    setCompletedCommand(null)
    setCurrentBulletText(editor, prompt)
    setMenu(null)
    if (command.outlineCommand) {
      runOutlineCommand(editor, command.outlineCommand)
      return
    }
    const skill = command.skill
    if (!skill) return
    runSkillIntoEditor(
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
      enabledToolIds,
      customTools,
    )
  }

  if (!menu || matches.length === 0) return null

  return (
    <ul className="slash-menu" style={{ top: menu.top, left: menu.left }}>
      {matches.map((command, i) => (
        <li
          key={command.id}
          className={i === active ? 'slash-item active' : 'slash-item'}
          onMouseDown={(e) => {
            e.preventDefault()
            complete(command)
          }}
        >
          <span className="slash-label">/{command.label}</span>
          <span className="slash-desc">
            {menu.query === command.label && menu.prompt.trim()
              ? 'Press Enter to run with this context'
              : `${command.description} · Enter or Tab to select`}
          </span>
        </li>
      ))}
    </ul>
  )
}
