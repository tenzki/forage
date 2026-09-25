import { useEffect, useId, useRef, useState, type ComponentPropsWithoutRef, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from './cn'

const CONTROL = 'w-full rounded-md border border-rule bg-paper-raised px-2.5 text-ink outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-neutral-400 hover:enabled:border-neutral-400 focus:border-ink-soft focus:shadow-[0_0_0_3px_rgba(112,87,163,0.14)] disabled:cursor-not-allowed disabled:bg-paper-sunk disabled:text-moss'

const LABEL = 'text-xs leading-4 font-normal text-ink-soft'

/**
 * Labelled control from docs/desktop.pen (`Field`). Wrap the control, or pass
 * `htmlFor` with the control's `id` when the label must stay a sibling.
 */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  className,
  children,
}: {
  label: ReactNode
  htmlFor?: string
  hint?: ReactNode
  error?: ReactNode
  className?: string
  children: ReactNode
}) {
  const note = error
    ? <span className="block text-xs leading-[1.45] text-clay" role="alert">{error}</span>
    : hint ? <span className="block text-xs leading-[1.45] text-moss">{hint}</span> : null
  const classes = cn('flex w-full flex-col gap-1.5', className)
  if (htmlFor) {
    return (
      <div data-slot="field" className={classes}>
        <label htmlFor={htmlFor} className={LABEL}>{label}</label>
        {children}
        {note}
      </div>
    )
  }
  return (
    <label data-slot="field" className={classes}>
      <span className={LABEL}>{label}</span>
      {children}
      {note}
    </label>
  )
}

export function Input({ className, mono = false, ...props }: ComponentPropsWithoutRef<'input'> & { mono?: boolean }) {
  return <input data-slot="input" className={cn(CONTROL, 'h-[34px]', mono ? 'font-mono text-xs' : 'text-[13px]', className)} {...props} />
}

export function Textarea({ className, mono = false, ...props }: ComponentPropsWithoutRef<'textarea'> & { mono?: boolean }) {
  return <textarea data-slot="textarea" className={cn(CONTROL, 'min-h-20 resize-y py-2 leading-[1.45]', mono ? 'font-mono text-xs' : 'text-[13px]', className)} {...props} />
}

interface SelectMenu {
  label: string | undefined
  options: Array<{ value: string; label: string; disabled: boolean }>
  highlighted: number
  top: number
  left: number
  width: number
}

const OPEN_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Enter', ' '])

/** The select's label text, without the option text a wrapping label also holds. */
function selectLabel(select: HTMLSelectElement): string | undefined {
  const label = select.getAttribute('aria-label') ?? select.labels?.[0]
  if (typeof label === 'string' || !label) return label ?? undefined
  const copy = label.cloneNode(true) as HTMLElement
  copy.querySelectorAll('select').forEach((node) => node.remove())
  return copy.textContent?.trim() || undefined
}

function nextEnabled(options: SelectMenu['options'], start: number, direction: 1 | -1): number {
  for (let index = start + direction; index >= 0 && index < options.length; index += direction) {
    if (!options[index]!.disabled) return index
  }
  return start
}

/**
 * Native select dressed as `Dropdown/Trigger`. The select keeps the value, the
 * label and the change event, but its popup is drawn here: WebKit renders the
 * native popup as an unstyled system menu.
 */
export function Select({ className, mono = false, onChange, onMouseDown, onKeyDown, onBlur, ...props }: ComponentPropsWithoutRef<'select'> & { mono?: boolean }) {
  const selectRef = useRef<HTMLSelectElement | null>(null)
  const menuRef = useRef<HTMLUListElement | null>(null)
  const [menu, setMenu] = useState<SelectMenu | null>(null)
  const listId = useId()

  function open() {
    const select = selectRef.current
    if (!select || select.disabled) return
    const options = [...select.options].map((option) => ({ value: option.value, label: option.label, disabled: option.disabled }))
    if (!options.length) return
    const rect = select.getBoundingClientRect()
    const selected = options.findIndex((option) => option.value === select.value && !option.disabled)
    setMenu({
      label: selectLabel(select),
      options,
      highlighted: selected >= 0 ? selected : nextEnabled(options, -1, 1),
      top: rect.bottom + 4,
      left: rect.left,
      width: rect.width,
    })
  }

  function choose(value: string) {
    const select = selectRef.current
    setMenu(null)
    if (!select || select.value === value) return
    // Set through the native setter so React's value tracker sees a change.
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  }

  useEffect(() => {
    if (!menu) return
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node
      if (!menuRef.current?.contains(target) && !selectRef.current?.contains(target)) setMenu(null)
    }
    const close = (event: Event) => {
      if (event.type === 'scroll' && menuRef.current?.contains(event.target as Node)) return
      setMenu(null)
    }
    document.addEventListener('pointerdown', closeOutside, true)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('pointerdown', closeOutside, true)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [menu])

  useEffect(() => {
    if (!menu) return
    menuRef.current?.querySelector<HTMLElement>('[data-highlighted]')?.scrollIntoView?.({ block: 'nearest' })
  }, [menu])

  function handleKeyDown(event: KeyboardEvent<HTMLSelectElement>) {
    onKeyDown?.(event)
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
    if (!menu) {
      if (!OPEN_KEYS.has(event.key)) return
      event.preventDefault()
      open()
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const highlighted = nextEnabled(menu.options, menu.highlighted, event.key === 'ArrowDown' ? 1 : -1)
      setMenu({ ...menu, highlighted })
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      const option = menu.options[menu.highlighted]
      if (option && !option.disabled) choose(option.value)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setMenu(null)
    } else if (event.key === 'Tab') {
      setMenu(null)
    }
  }

  return (
    <span className="relative flex w-full">
      <select
        ref={selectRef}
        data-slot="select"
        aria-expanded={menu ? true : undefined}
        aria-controls={menu ? listId : undefined}
        className={cn(CONTROL, 'h-[34px] cursor-pointer appearance-none pr-8', mono ? 'font-mono text-xs' : 'text-[13px]', className)}
        onMouseDown={(event) => {
          onMouseDown?.(event)
          if (event.defaultPrevented || event.button !== 0) return
          event.preventDefault()
          event.currentTarget.focus()
          if (menu) setMenu(null)
          else open()
        }}
        onKeyDown={handleKeyDown}
        onChange={(event) => {
          setMenu(null)
          onChange?.(event)
        }}
        onBlur={(event) => {
          onBlur?.(event)
          setMenu(null)
        }}
        {...props}
      />
      <ChevronDown size={14} className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-moss" aria-hidden="true" />
      {menu && createPortal(
        <ul
          ref={menuRef}
          id={listId}
          role="listbox"
          aria-label={menu.label}
          data-slot="select-menu"
          data-origin="top-left"
          className="t-dropdown is-open fixed z-80 m-0 max-h-64 list-none overflow-y-auto rounded-[10px] border border-rule bg-paper-raised p-1 font-sans shadow-[0_8px_24px_rgba(32,61,50,0.12)]"
          style={{ top: menu.top, left: menu.left, minWidth: menu.width }}
          onMouseDown={(event) => event.preventDefault()}
        >
          {menu.options.map((option, index) => {
            const selected = option.value === selectRef.current?.value
            return (
              <li
                key={`${option.value}:${index}`}
                role="option"
                aria-selected={selected}
                aria-disabled={option.disabled || undefined}
                data-highlighted={index === menu.highlighted || undefined}
                onMouseEnter={() => { if (!option.disabled) setMenu({ ...menu, highlighted: index }) }}
                onClick={() => { if (!option.disabled) choose(option.value) }}
                className={cn(
                  'flex cursor-pointer items-center justify-between gap-4 rounded-sm px-2.5 py-2 text-ink',
                  mono ? 'font-mono text-xs' : 'text-[13px]',
                  index === menu.highlighted && 'bg-sage',
                  option.disabled && 'cursor-not-allowed text-neutral-400',
                )}
              >
                <span className="truncate">{option.label}</span>
                {selected ? <Check size={13} strokeWidth={2.2} className="shrink-0 text-ink" aria-hidden="true" /> : null}
              </li>
            )
          })}
        </ul>,
        document.body,
      )}
    </span>
  )
}
