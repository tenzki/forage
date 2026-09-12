import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Compass, Keyboard, ListTree, PencilLine, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

interface ShortcutItem {
  label: string
  keys: string[][]
  detail?: string
}

interface ShortcutGroup {
  title: string
  description: string
  icon: LucideIcon
  shortcuts: ShortcutItem[]
}

const IS_APPLE_PLATFORM = typeof navigator !== 'undefined'
  && /Mac|iPhone|iPad|iPod/u.test(`${navigator.platform} ${navigator.userAgent}`)
const PRIMARY_MODIFIER = IS_APPLE_PLATFORM ? '⌘' : 'Ctrl'

const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    title: 'Navigate',
    description: 'Move around Forage without leaving the keyboard.',
    icon: Compass,
    shortcuts: [
      { label: 'Search commands and bullets', keys: [[PRIMARY_MODIFIER, 'K']] },
      { label: 'Go back', keys: [[PRIMARY_MODIFIER, '[']] },
      { label: 'Go forward', keys: [[PRIMARY_MODIFIER, ']']] },
      { label: 'Open Settings', keys: [[PRIMARY_MODIFIER, ',']] },
      { label: 'Open keyboard shortcuts', keys: [[PRIMARY_MODIFIER, '?']] },
      { label: 'Close the current panel or menu', keys: [['Esc']] },
    ],
  },
  {
    title: 'Build your outline',
    description: 'Create structure while keeping your hands on the keys.',
    icon: ListTree,
    shortcuts: [
      { label: 'Create the next bullet', keys: [['Enter']] },
      { label: 'Add or edit a note', keys: [['Shift', 'Enter']], detail: 'Inside a note, adds a new line.' },
      { label: 'Indent bullet', keys: [['Tab']] },
      { label: 'Outdent bullet', keys: [['Shift', 'Tab']] },
      { label: 'Move branch up', keys: [['Alt', '↑']] },
      { label: 'Move branch down', keys: [['Alt', '↓']] },
    ],
  },
  {
    title: 'Edit and organize',
    description: 'Change content and keep work moving.',
    icon: PencilLine,
    shortcuts: [
      { label: 'Cycle bullet, todo, and complete', keys: [[PRIMARY_MODIFIER, 'Enter']] },
      { label: 'Undo', keys: [[PRIMARY_MODIFIER, 'Z']] },
      { label: 'Redo', keys: [[PRIMARY_MODIFIER, 'Shift', 'Z']] },
      { label: 'Bold', keys: [[PRIMARY_MODIFIER, 'B']] },
      { label: 'Italic', keys: [[PRIMARY_MODIFIER, 'I']] },
      { label: 'Strike through', keys: [[PRIMARY_MODIFIER, 'Shift', 'S']] },
    ],
  },
]

function ShortcutKeys({ chords }: { chords: string[][] }) {
  return (
    <span className="flex shrink-0 items-center gap-1" aria-label={chords.map((keys) => keys.join(' plus ')).join(' or ')}>
      {chords.map((keys, chordIndex) => (
        <span className="flex items-center gap-1" key={keys.join('-')}>
          {chordIndex > 0 && <span className="px-0.5 text-[10px] text-neutral-400">or</span>}
          {keys.map((key) => (
            <kbd
              className="min-w-6 rounded-md border border-neutral-200 bg-neutral-50 px-1.5 py-1 text-center font-mono text-[10px] font-medium leading-none text-neutral-600 shadow-[0_1px_0_white_inset,0_1px_1px_rgb(0_0_0/0.04)]"
              key={key}
            >
              {key}
            </kbd>
          ))}
        </span>
      ))}
    </span>
  )
}

export function KeyboardShortcutsPanel({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null
    dialogRef.current?.focus()
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab') return
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') ?? [])]
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('keydown', closeOnEscape)
      previouslyFocused?.focus()
    }
  }, [onClose])

  return createPortal(
    <div className="fixed inset-0 z-[100] grid place-items-center bg-neutral-950/25 p-5 backdrop-blur-[2px] max-sm:p-2" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="flex max-h-[88vh] w-full max-w-[780px] flex-col overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-[0_24px_80px_-20px_rgb(0_0_0/0.38)] outline-none"
        role="dialog"
        aria-modal="true"
        aria-labelledby="keyboard-shortcuts-title"
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-start gap-3 border-b border-neutral-100 px-5 py-4">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-neutral-200 bg-neutral-50 text-neutral-700 shadow-xs">
            <Keyboard size={17} strokeWidth={1.8} aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold tracking-[-0.01em] text-neutral-900" id="keyboard-shortcuts-title">Keyboard shortcuts</h2>
            <p className="mt-0.5 text-xs leading-5 text-neutral-500">
              A quick reference for writing and organizing in Forage.
            </p>
          </div>
          <button
            className="grid size-8 shrink-0 cursor-pointer place-items-center rounded-lg border border-transparent bg-transparent text-neutral-400 outline-none transition-colors hover:border-neutral-200 hover:bg-neutral-50 hover:text-neutral-800 focus-visible:border-neutral-300 focus-visible:bg-neutral-50"
            aria-label="Close keyboard shortcuts"
            onClick={onClose}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </header>

        <div className="overflow-y-auto p-4 max-sm:p-3" aria-label="Keyboard shortcut reference">
          <div className="grid gap-3 md:grid-cols-2">
            {SHORTCUT_GROUPS.map(({ title, description, icon: Icon, shortcuts }) => {
              const headingId = `shortcut-group-${title.replace(/\s+/g, '-').toLowerCase()}`
              return (
                <section className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-xs md:last:col-span-2" key={title} aria-labelledby={headingId}>
                  <div className="flex gap-3 border-b border-neutral-100 bg-neutral-50/70 px-4 py-3.5">
                    <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-neutral-200 bg-white text-neutral-600 shadow-xs">
                      <Icon size={15} strokeWidth={1.8} aria-hidden="true" />
                    </span>
                    <span>
                      <h3 className="text-[13px] font-semibold text-neutral-900" id={headingId}>{title}</h3>
                      <p className="mt-0.5 text-[11px] leading-4 text-neutral-500">{description}</p>
                    </span>
                  </div>
                  <dl className="divide-y divide-neutral-100 px-4">
                    {shortcuts.map((shortcut) => (
                      <div className="flex min-h-11 items-center justify-between gap-4 py-2.5" key={shortcut.label}>
                        <div className="min-w-0">
                          <dt className="text-xs font-medium text-neutral-700">{shortcut.label}</dt>
                          {shortcut.detail && <dd className="mt-0.5 text-[10px] leading-4 text-neutral-400">{shortcut.detail}</dd>}
                        </div>
                        <dd><ShortcutKeys chords={shortcut.keys} /></dd>
                      </div>
                    ))}
                  </dl>
                </section>
              )
            })}
          </div>
        </div>
        <footer className="flex items-center justify-between gap-3 border-t border-neutral-100 bg-neutral-50/70 px-5 py-3 text-[11px] text-neutral-400">
          <span>{IS_APPLE_PLATFORM ? 'Use Ctrl instead of ⌘ on Windows and Linux.' : 'Use ⌘ instead of Ctrl on macOS.'}</span>
          <span className="flex shrink-0 items-center gap-1.5"><kbd className="rounded border border-neutral-200 bg-white px-1.5 py-0.5 font-mono text-[9px] text-neutral-500 shadow-xs">Esc</kbd> to close</span>
        </footer>
      </section>
    </div>,
    document.body,
  )
}
