// Slash-command menu. When the current bullet's text starts with "/", show
// matching skills and local outline commands near the caret. Selecting a skill
// completes "/skill " so the user can add a prompt; Enter then runs it.

import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import type { SkillDefinition } from '../../agent/definitions'
import { resolveAgentContext } from '../../agent/context'
import {
  currentListItemId,
  runSkillIntoEditor,
  setCurrentBulletText,
} from '../../agent/insertIntoEditor'
import { focusOrCreateBulletNote } from '../../editor/bulletNote'
import { activeInternalLinkAtSelection } from '../../editor/internalLinks'
import {
  OUTLINE_COMMANDS,
  type OutlineCommandDefinition,
} from '../../editor/commandDefinitions'
import { clearSkillContext, showSkillContext, showSkillContextError } from '../../editor/contextPreview'
import {
  currentBulletId,
  setBulletKind,
  setTodoCompleted,
} from '../../editor/outlineModel'
import { useSettingsStore } from '../../store/settingsStore'
import type { ActivityReporter } from '../../agent/activity'

interface CommandChoice {
  id: string
  label: string
  description: string
  skill?: SkillDefinition
  outlineCommand?: OutlineCommandDefinition
}

interface MenuState {
  query: string
  prompt: string
  top: number
  left: number
}

function commandChoices(skills: SkillDefinition[]): CommandChoice[] {
  return [
    ...OUTLINE_COMMANDS.map((outlineCommand) => ({
      ...outlineCommand,
      outlineCommand,
    })),
    ...skills.map((skill) => ({
      id: skill.id,
      label: skill.label,
      description: skill.description,
      skill,
    })),
  ]
}

function runOutlineCommand(editor: Editor, command: OutlineCommandDefinition): void {
  const nodeId = currentBulletId(editor)
  if (!nodeId) return
  if (command.id === 'note') {
    focusOrCreateBulletNote(editor, nodeId)
  } else if (command.id === 'bullet') {
    setBulletKind(editor, nodeId, 'bullet')
  } else {
    setTodoCompleted(editor, nodeId, command.id === 'done')
  }
}

function readSlashState(editor: Editor): MenuState | null {
  const { $from, empty } = editor.state.selection
  if (!empty) return null
  let text = ''
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name === 'listItem') {
      text = $from.node(depth).firstChild?.textContent ?? ''
      break
    }
  }
  if (!text.startsWith('/')) return null
  const body = text.slice(1)
  const spaceIndex = body.indexOf(' ')
  const query = spaceIndex === -1 ? body : body.slice(0, spaceIndex)
  const prompt = spaceIndex === -1 ? '' : body.slice(spaceIndex + 1)
  const coords = editor.view.coordsAtPos($from.pos)
  return { query, prompt, top: coords.bottom + 4, left: coords.left }
}

export function SlashMenu({
  editor,
  onError,
  onActivity,
}: {
  editor: Editor | null
  onError: (message: string | null) => void
  onActivity?: ActivityReporter
}) {
  const authMode = useSettingsStore((state) => state.authMode)
  const openAiApiKey = useSettingsStore((state) => state.openAiApiKey)
  const oauthCredential = useSettingsStore((state) => state.oauthCredential)
  const modelId = useSettingsStore((state) => state.modelId)
  const enabledToolIds = useSettingsStore((state) => state.enabledToolIds)
  const customTools = useSettingsStore((state) => state.customTools)
  const agents = useSettingsStore((state) => state.agents)
  const skills = useSettingsStore((state) => state.skills)
  const setOAuthCredential = useSettingsStore((state) => state.setOAuthCredential)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [active, setActive] = useState(0)
  const [completedCommand, setCompletedCommand] = useState<CommandChoice | null>(null)
  const [contextError, setContextError] = useState<string | null>(null)
  const completedCommandRef = useRef<CommandChoice | null>(null)
  const choices = commandChoices(skills)
  const matches = menu
    ? choices.filter((command) => command.label.startsWith(menu.query))
    : []

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

  useEffect(() => {
    if (!editor) return
    const refresh = () => {
      const state = readSlashState(editor)
      const invocationNodeId = currentListItemId(editor)
      if (!editor.isFocused || !state || !invocationNodeId) {
        setContextError(null)
        clearSkillContext(editor)
        return
      }
      const candidates = commandChoices(skills)
        .filter((command) => command.label.startsWith(state.query))
      const command = completedCommandRef.current?.label === state.query
        ? completedCommandRef.current
        : candidates[active] ?? candidates[0]
      if (!command?.skill) {
        setContextError(null)
        clearSkillContext(editor)
        return
      }
      try {
        showSkillContext(editor, resolveAgentContext(editor.state.doc, invocationNodeId))
        setContextError(null)
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        setContextError(detail)
        showSkillContextError(editor, invocationNodeId, detail)
      }
    }
    const blur = () => {
      setContextError(null)
      clearSkillContext(editor)
    }
    refresh()
    editor.on('selectionUpdate', refresh)
    editor.on('update', refresh)
    editor.on('focus', refresh)
    editor.on('blur', blur)
    return () => {
      editor.off('selectionUpdate', refresh)
      editor.off('update', refresh)
      editor.off('focus', refresh)
      editor.off('blur', blur)
      clearSkillContext(editor)
    }
  }, [editor, skills, menu, completedCommand, active])

  useEffect(() => {
    if (!editor || !menu || matches.length === 0) return
    const onKey = (event: KeyboardEvent) => {
      const command = matches[active] ?? matches[0]
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActive((index) => (index + 1) % matches.length)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActive((index) => (index - 1 + matches.length) % matches.length)
      } else if (event.key === 'Tab' && !event.shiftKey) {
        if (activeInternalLinkAtSelection(editor.state)) return
        event.preventDefault()
        complete(command)
      } else if (event.key === 'Enter') {
        if (activeInternalLinkAtSelection(editor.state)) return
        event.preventDefault()
        const hasPrompt = menu.query === command.label && menu.prompt.trim().length > 0
        if (command.outlineCommand || hasPrompt || event.metaKey || event.ctrlKey) run(command)
        else complete(command)
      } else if (event.key === 'Escape') {
        event.preventDefault()
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
      if (activeInternalLinkAtSelection(editor.state)) return
      const state = readSlashState(editor)
      if (state?.query !== completedCommand.label) return
      event.preventDefault()
      run(completedCommand)
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [editor, completedCommand])

  function complete(command: CommandChoice): void {
    if (!editor) return
    const prompt = menu?.prompt.trimStart() ?? ''
    const text = `/${command.label}${prompt ? ` ${prompt}` : ' '}`
    completedCommandRef.current = command
    setCompletedCommand(command)
    setCurrentBulletText(editor, text, true)
    setMenu(null)
    editor.view.focus()
  }

  function run(command: CommandChoice): void {
    if (!editor) return
    const state = readSlashState(editor)
    const context = state?.query === command.label ? state.prompt : menu?.prompt
    const prompt = (context || (command.skill ? command.label : '')).trim()
    completedCommandRef.current = null
    setCompletedCommand(null)
    if (command.outlineCommand) {
      const activityId = `command-${Date.now()}`
      onActivity?.({ id: activityId, phase: 'start', kind: 'command', label: `/${command.outlineCommand.label}` })
      clearSkillContext(editor)
      setCurrentBulletText(editor, prompt)
      setMenu(null)
      runOutlineCommand(editor, command.outlineCommand)
      onActivity?.({ id: activityId, phase: 'complete', kind: 'command', label: `/${command.outlineCommand.label}` })
      return
    }
    const skill = command.skill
    if (!skill) return
    const agent = agents.find((candidate) => candidate.id === skill.agentId)
    if (!agent) {
      onError(`The agent assigned to /${skill.label} no longer exists.`)
      return
    }
    onError(null)
    try {
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
        agent,
        prompt,
        enabledToolIds,
        customTools,
        onError,
        onActivity,
      )
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      onError(detail)
      const invocationNodeId = currentListItemId(editor)
      if (invocationNodeId) showSkillContextError(editor, invocationNodeId, detail)
      setContextError(detail)
      if (state) setMenu(state)
      return
    }
    clearSkillContext(editor)
    setContextError(null)
    setMenu(null)
  }

  if (!menu || matches.length === 0) return null

  return (
    <ul className="slash-menu" style={{ top: menu.top, left: menu.left }}>
      {contextError && <li className="slash-context-error" role="alert">{contextError}</li>}
      {matches.map((command, index) => (
        <li
          key={`${command.outlineCommand ? 'outline' : 'skill'}:${command.id}`}
          className={index === active ? 'slash-item active' : 'slash-item'}
          onMouseDown={(event) => {
            event.preventDefault()
            complete(command)
          }}
        >
          <span className="slash-label">/{command.label}</span>
          <span className="slash-desc">
            {menu.query === command.label && menu.prompt.trim()
              ? 'Press Enter to run with this prompt'
              : `${command.description} · Enter or Tab to select`}
          </span>
        </li>
      ))}
    </ul>
  )
}
