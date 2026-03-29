import { Node } from '@tiptap/core'
import { PluginKey } from '@tiptap/pm/state'
import Suggestion from '@tiptap/suggestion'
import { createPortal } from 'react-dom'
import { useState, useEffect, useCallback } from 'react'

// ─── Skill Registry ──────────────────────────────────────────────────────────

export interface Skill {
  id: string
  name: string
  description: string
  outputMode: 'children' | 'replace'
}

export const SKILLS: Skill[] = [
  {
    id: 'ask',
    name: 'ask',
    description: 'Ask a question — creates a response node',
    outputMode: 'children',
  },
  {
    id: 'research',
    name: 'research',
    description: 'Deep research — creates multiple child nodes',
    outputMode: 'children',
  },
  {
    id: 'brainstorm',
    name: 'brainstorm',
    description: 'Brainstorm ideas — creates bullet-point children',
    outputMode: 'children',
  },
]

// ─── Pure Helper Functions (exported for testing) ─────────────────────────────

/**
 * Filter skills by prefix match on skill name.
 * Empty query returns all skills.
 */
export function filterSkills(query: string): Skill[] {
  if (query === '') return SKILLS
  const lower = query.toLowerCase()
  return SKILLS.filter((s) => s.name.startsWith(lower))
}

/**
 * Determine if a slash should trigger the suggestion popup.
 * Returns false when preceded by ':' (URL context like 'https:/').
 */
export function shouldAllowSlash(precedingChar: string | null): boolean {
  if (precedingChar === ':') return false
  return true
}

/**
 * Parse a slash command input into skill name and args.
 * Input may or may not have leading '/'.
 */
export function parseSlashInput(input: string): { skillName: string; args: string } {
  // Strip leading '/' if present
  const stripped = input.startsWith('/') ? input.slice(1) : input
  const spaceIdx = stripped.indexOf(' ')
  if (spaceIdx === -1) {
    return { skillName: stripped, args: '' }
  }
  return {
    skillName: stripped.slice(0, spaceIdx),
    args: stripped.slice(spaceIdx + 1),
  }
}

/**
 * Detect if text contains a complete slash command ready to invoke.
 * A complete slash command is: /skillname <space> <non-empty query>
 * Returns { skillId, args } if matched, or null if not a valid slash command invocation.
 */
export function detectSlashCommand(text: string): { skillId: string; args: string } | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('/')) return null
  const { skillName, args } = parseSlashInput(trimmed)
  if (!skillName) return null
  // Require at least one known skill name (exact match)
  const skill = SKILLS.find((s) => s.name === skillName)
  if (!skill) return null
  // Require non-empty args — user must have typed something after "/skillname "
  if (!args.trim()) return null
  return { skillId: skill.id, args: args.trim() }
}

// ─── Suggestion Popup ─────────────────────────────────────────────────────────

interface SlashSuggestionPopupProps {
  items: Skill[]
  command: (skill: Skill) => void
  clientRect: (() => DOMRect | null) | null
}

function SlashSuggestionPopup({ items, command, clientRect }: SlashSuggestionPopupProps) {
  const [selectedIndex, setSelectedIndex] = useState(0)

  const rect = clientRect?.()

  const selectItem = useCallback(
    (index: number) => {
      const skill = items[index]
      if (skill) {
        command(skill)
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
    <div className="slash-suggestion-popup" style={style}>
      {items.map((skill, index) => (
        <div
          key={skill.id}
          className={`slash-suggestion-item${index === selectedIndex ? ' slash-suggestion-item--active' : ''}`}
          onMouseDown={(e) => {
            e.preventDefault()
            selectItem(index)
          }}
        >
          <span className="slash-suggestion-name">/{skill.name}</span>
          <span className="slash-suggestion-description">{skill.description}</span>
        </div>
      ))}
    </div>,
    document.body
  )
}

// ─── Active Suggestion State ──────────────────────────────────────────────────

/**
 * Module-level flag: true while the slash suggestion popup is visible.
 * Read by OutlinerKeys to yield Enter/Arrow events to the suggestion plugin
 * instead of consuming them for node navigation.
 */
export let isSlashSuggestionActive = false

// ─── Extension Options ────────────────────────────────────────────────────────

export interface SlashCommandOptions {
  /** @deprecated Use onSkillInvoked in NodeEditor Enter handler — not called by extension anymore */
  onSkillInvoked: (skillId: string, args: string) => void
}

// ─── SlashCommand Extension ──────────────────────────────────────────────────

export const SlashCommand = Node.create<SlashCommandOptions>({
  name: 'slashCommand',

  group: 'inline',
  inline: true,
  selectable: false,
  atom: true,

  addOptions() {
    return {
      onSkillInvoked: () => {},
    }
  },

  parseHTML() {
    return []
  },

  renderHTML() {
    return ['span', {}]
  },

  addProseMirrorPlugins() {
    let popupRoot: import('react-dom/client').Root | null = null
    let popupContainer: HTMLDivElement | null = null

    function getOrCreateContainer(): HTMLDivElement {
      if (!popupContainer) {
        popupContainer = document.createElement('div')
        popupContainer.id = 'slash-suggestion-portal'
        document.body.appendChild(popupContainer)
      }
      return popupContainer
    }

    function renderPopup(props: SlashSuggestionPopupProps | null) {
      if (typeof window === 'undefined') return

      import('react-dom/client').then(({ createRoot }) => {
        const container = getOrCreateContainer()

        if (!popupRoot) {
          popupRoot = createRoot(container)
        }

        if (props) {
          popupRoot.render(<SlashSuggestionPopup {...props} />)
        } else {
          popupRoot.render(null)
        }
      })
    }

    return [
      Suggestion({
        pluginKey: new PluginKey('slashSuggestion'),
        editor: this.editor,
        char: '/',
        startOfLine: false,
        allowSpaces: false,
        allowedPrefixes: null,

        allow: ({ state, range }) => {
          // Check the character immediately before the '/' trigger
          const $from = state.doc.resolve(range.from)
          const textBefore = $from.nodeBefore?.textContent ?? ''
          const charBefore = textBefore.length > 0 ? textBefore[textBefore.length - 1] : null
          return shouldAllowSlash(charBefore)
        },

        items: ({ query }) => {
          // Split on first space to get skill prefix from query
          const prefix = query.split(' ')[0]
          return filterSkills(prefix)
        },

        command: ({ editor, range, props: skill }) => {
          // Selection from dropdown: replace the typed "/" (and any partial skill name)
          // with "/skillname " so the user can type their query after it.
          // Do NOT invoke the skill here — invocation happens on Enter.
          const skillName = (skill as Skill).name
          editor
            .chain()
            .focus()
            .deleteRange(range)
            .insertContent(`/${skillName} `)
            .run()
        },

        render: () => {
          let clientRectFn: (() => DOMRect | null) | null = null
          let currentCommand: ((skill: Skill) => void) | null = null
          let currentItems: Skill[] = []

          return {
            onStart: (props) => {
              isSlashSuggestionActive = true
              clientRectFn = props.clientRect ?? null
              currentItems = props.items as Skill[]
              currentCommand = props.command as unknown as (skill: Skill) => void

              renderPopup({
                items: currentItems,
                command: (skill) => currentCommand?.(skill),
                clientRect: clientRectFn,
              })
            },

            onUpdate: (props) => {
              isSlashSuggestionActive = true
              clientRectFn = props.clientRect ?? null
              currentItems = props.items as Skill[]
              currentCommand = props.command as unknown as (skill: Skill) => void

              renderPopup({
                items: currentItems,
                command: (skill) => currentCommand?.(skill),
                clientRect: clientRectFn,
              })
            },

            onKeyDown: ({ event }) => {
              if (event.key === 'Escape') {
                renderPopup(null)
                return true
              }
              if (
                currentItems.length > 0 &&
                (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter')
              ) {
                return true
              }
              return false
            },

            onExit: () => {
              isSlashSuggestionActive = false
              // Clear stale references BEFORE the async unmount so the still-mounted
              // popup's capture-phase Enter listener cannot re-invoke the command
              // with a stale range while React schedules the component unmount.
              currentItems = []
              currentCommand = null
              renderPopup(null)
            },
          }
        },
      }),
    ]
  },
})

export default SlashCommand
