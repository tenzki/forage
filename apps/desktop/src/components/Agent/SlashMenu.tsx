// Slash-command menu. When the current bullet's text starts with "/", show
// matching skills and local outline commands near the caret. Selecting a skill
// completes "/skill " so the user can add a prompt; Enter then runs it.

import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/react'
import type { SkillDefinition } from '../../agent/definitions'
import { currentListItemId, setCurrentBulletText } from '../../agent/insertIntoEditor'
import { focusOrCreateBulletNote } from '../../editor/bulletNote'
import { activeInternalLinkAtSelection } from '../../editor/internalLinks'
import { OUTLINE_COMMANDS, type OutlineCommandDefinition } from '../../editor/commandDefinitions'
import { clearSkillContext } from '../../editor/contextPreview'
import { currentBulletId, setBulletKind, setTodoCompleted } from '../../editor/outlineModel'
import { useSettingsStore } from '../../store/settingsStore'
import type { ActivityReporter } from '../../agent/activity'
import { OUTLINE_RUN_SKILL_EVENT, type SkillRunConversation, type SkillRunRequest, type SkillRunSteering } from '../../agent/skillRuns'
import { skillExecution } from '../../agent/skillExecution'
import { skillAllowsEmptyPrompt, skillInvocationPrompt } from '../../agent/skillPreview'

export { skillAllowsEmptyPrompt, skillInvocationPrompt } from '../../agent/skillPreview'

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
  onBeforeServerRun,
  onAfterServerRun,
  onRegisterExtensionCancellation,
}: {
  editor: Editor | null
  onError: (message: string | null) => void
  onActivity?: ActivityReporter
  onBeforeServerRun?: () => Promise<void>
  onAfterServerRun?: () => Promise<void>
  onRegisterExtensionCancellation?: (runId: string, cancel: (() => void) | null) => void
}) {
  const skills = useSettingsStore((state) => state.skills)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [active, setActive] = useState(0)
  const [completedCommand, setCompletedCommand] = useState<CommandChoice | null>(null)
  const [contextError, setContextError] = useState<string | null>(null)
  const completedCommandRef = useRef<CommandChoice | null>(null)
  const dismissedInvocationRef = useRef<{ nodeId: string; query: string; prompt: string } | null>(null)
  const isDismissed = (state: MenuState | null) => {
    const dismissed = dismissedInvocationRef.current
    return Boolean(editor && state && dismissed
      && currentListItemId(editor) === dismissed.nodeId
      && state.query === dismissed.query && state.prompt === dismissed.prompt)
  }
  const choices = commandChoices(skills)
  const matches = menu
    ? choices.filter((command) => command.label.startsWith(menu.query))
    : []

  useEffect(() => {
    if (!editor) return
    const update = () => {
      const state = readSlashState(editor)
      if (isDismissed(state)) {
        setMenu(null)
        return
      }
      dismissedInvocationRef.current = null
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
    let cancelPreview: (() => void) | undefined
    const refresh = () => {
      cancelPreview?.()
      cancelPreview = undefined
      const state = readSlashState(editor)
      const invocationNodeId = currentListItemId(editor)
      if (!editor.isFocused || !state || !invocationNodeId || isDismissed(state)) {
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
      cancelPreview = skillExecution.preview({
        editor, skillId: command.skill.id, prompt: state.prompt, invocationNodeId,
      }, setContextError)
    }
    const blur = () => {
      cancelPreview?.()
      cancelPreview = undefined
      setContextError(null)
      clearSkillContext(editor)
    }
    const unsubscribeAvailability = skillExecution.subscribeAvailability(refresh)
    refresh()
    editor.on('selectionUpdate', refresh)
    editor.on('update', refresh)
    editor.on('focus', refresh)
    editor.on('blur', blur)
    return () => {
      cancelPreview?.()
      unsubscribeAvailability()
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
        const allowsEmptyPrompt = command.skill && skillAllowsEmptyPrompt(command.skill) && menu.query === command.label
        if (command.outlineCommand || hasPrompt || allowsEmptyPrompt || event.metaKey || event.ctrlKey) run(command)
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
    const prompt = command.skill ? skillInvocationPrompt(command.skill, context) : (context ?? '').trim()
    completedCommandRef.current = null
    setCompletedCommand(null)
    if (command.outlineCommand) {
      const activityId = `command-${Date.now()}`
      const commandNodeId = currentListItemId(editor)
      const commandLabel = `/${command.outlineCommand.label}`
      const nodeId = commandNodeId ? { nodeId: commandNodeId } : {}
      onActivity?.({ id: activityId, phase: 'start', kind: 'command', label: commandLabel, ...nodeId })
      clearSkillContext(editor)
      setCurrentBulletText(editor, prompt)
      setMenu(null)
      runOutlineCommand(editor, command.outlineCommand)
      onActivity?.({ id: activityId, phase: 'complete', kind: 'command', label: commandLabel, ...nodeId })
      return
    }
    const skill = command.skill
    if (!skill) return
    const invocationNodeId = currentListItemId(editor)
    if (!invocationNodeId) {
      onError('Could not find the skill invocation bullet.')
      return
    }
    runSkill(skill, prompt, invocationNodeId)
  }

  /**
   * Run `skill` for the bullet `invocationNodeId`. `steering` marks a follow-up
   * iteration: the call keeps its original label and records the user's note.
   * `conversation` continues a call's agent conversation, on this device or on
   * the server; without it, a run starts a new call of its own.
   */
  function runSkill(
    skill: SkillDefinition,
    prompt: string,
    invocationNodeId: string,
    steering?: SkillRunSteering,
    conversation?: SkillRunConversation,
  ): void {
    if (!editor) return
    // The invocation keeps its slash prefix until result placement. Streaming and
    // selection transactions must not reopen its menu or context preview.
    const slashState = readSlashState(editor)
    if (slashState && currentListItemId(editor) === invocationNodeId) {
      dismissedInvocationRef.current = { nodeId: invocationNodeId, query: slashState.query, prompt: slashState.prompt }
      completedCommandRef.current = null
      setCompletedCommand(null)
      setMenu(null)
    }
    const handle = skillExecution.execute({ editor, skillId: skill.id, prompt, invocationNodeId, steering, conversation }, {
      onError, onActivity, onContextError: setContextError, onBeforeServerRun, onAfterServerRun,
    })
    onRegisterExtensionCancellation?.(handle.runId, handle.cancel)
    void handle.completion.finally(() => onRegisterExtensionCancellation?.(handle.runId, null))
  }

  const runSkillRef = useRef(runSkill)
  runSkillRef.current = runSkill

  // Runs requested elsewhere: the reader's Summarize and activity steering.
  useEffect(() => {
    if (!editor) return
    const onRunRequest = (event: Event) => {
      const request = (event as CustomEvent<SkillRunRequest>).detail
      if (!request) return
      const skill = useSettingsStore.getState().skills.find((candidate) => candidate.label === request.skillLabel)
      if (!skill) {
        onError(`/${request.skillLabel} no longer exists.`)
        return
      }
      runSkillRef.current(skill, request.prompt, request.invocationNodeId, request.steering, request.conversation)
    }
    window.addEventListener(OUTLINE_RUN_SKILL_EVENT, onRunRequest)
    return () => window.removeEventListener(OUTLINE_RUN_SKILL_EVENT, onRunRequest)
  }, [editor, onError])

  if (!menu || matches.length === 0) return null

  return (
    <ul className="slash-menu t-dropdown is-open" data-origin="top-left" style={{ top: menu.top, left: menu.left }}>
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
              : [command.description, 'Enter or Tab to select'].filter(Boolean).join(' · ')}
          </span>
        </li>
      ))}
    </ul>
  )
}
