import { useCallback, useEffect, useId, useMemo, useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from './cn'

export type ComboboxFieldOption = Readonly<{
  value: string
  label: string
  disabled?: boolean
}>

export interface ComboboxFieldInputProps {
  label: string
  hideLabel?: boolean
  options: readonly ComboboxFieldOption[]
  value: string
  onValueChange: (value: string) => void
  placeholder?: string
  emptyMessage?: string
  disabled?: boolean
  /** Clears the query after each pick, for "add an item" pickers whose value stays empty. */
  clearOnSelect?: boolean
  className?: string
}

function findNextEnabledIndex(options: readonly ComboboxFieldOption[], start: number, direction: 1 | -1): number {
  const count = options.length
  for (let step = 1; step <= count; step += 1) {
    const index = (start + direction * step + count) % count
    if (!options[index]?.disabled) return index
  }
  return -1
}

// Adapted from OpenSourceUI's ComboboxFieldInput (MIT), controlled and trimmed for Forage settings.
export function ComboboxFieldInput({
  label,
  hideLabel = false,
  options,
  value,
  onValueChange,
  placeholder,
  emptyMessage = 'No results found.',
  disabled = false,
  clearOnSelect = false,
  className,
}: ComboboxFieldInputProps) {
  const fieldId = useId()
  const listboxId = `${fieldId}-listbox`
  const rootRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const blurTimerRef = useRef<number | null>(null)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [highlighted, setHighlighted] = useState(-1)

  const selectedOption = options.find((option) => option.value === value)
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return normalized ? options.filter((option) => option.label.toLowerCase().includes(normalized)) : options
  }, [options, query])
  const displayValue = open || clearOnSelect ? query : (selectedOption?.label ?? query)

  const close = useCallback(() => {
    if (blurTimerRef.current !== null) {
      window.clearTimeout(blurTimerRef.current)
      blurTimerRef.current = null
    }
    setOpen(false)
    setHighlighted(-1)
    setQuery(clearOnSelect ? '' : (selectedOption?.label ?? ''))
  }, [clearOnSelect, selectedOption?.label])

  const openList = useCallback(() => {
    if (disabled) return
    setOpen(true)
    setQuery('')
    const index = options.findIndex((option) => option.value === value && !option.disabled)
    setHighlighted(index >= 0 ? index : options.findIndex((option) => !option.disabled))
  }, [disabled, options, value])

  const selectOption = useCallback((option: ComboboxFieldOption) => {
    if (option.disabled) return
    onValueChange(option.value)
    setQuery(clearOnSelect ? '' : option.label)
    setOpen(false)
    setHighlighted(-1)
  }, [clearOnSelect, onValueChange])

  useEffect(() => {
    if (!open) return
    function handlePointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) close()
    }
    document.addEventListener('pointerdown', handlePointerDown)
    return () => document.removeEventListener('pointerdown', handlePointerDown)
  }, [close, open])

  useEffect(() => () => {
    if (blurTimerRef.current !== null) window.clearTimeout(blurTimerRef.current)
  }, [])

  useEffect(() => {
    if (open && highlighted >= filtered.length) setHighlighted(filtered.findIndex((option) => !option.disabled))
  }, [filtered, highlighted, open])

  function handleInputChange(event: ChangeEvent<HTMLInputElement>) {
    const nextQuery = event.target.value
    const normalized = nextQuery.trim().toLowerCase()
    const nextOptions = normalized ? options.filter((option) => option.label.toLowerCase().includes(normalized)) : options
    setQuery(nextQuery)
    setOpen(true)
    setHighlighted(nextOptions.findIndex((option) => !option.disabled))
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (disabled) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!open) { openList(); return }
      const direction = event.key === 'ArrowDown' ? 1 : -1
      const start = highlighted < 0 ? (direction === 1 ? -1 : filtered.length) : highlighted
      const next = findNextEnabledIndex(filtered, start, direction)
      if (next >= 0) setHighlighted(next)
      return
    }
    if (event.key === 'Enter' && open && highlighted >= 0) {
      event.preventDefault()
      const option = filtered[highlighted]
      if (option) selectOption(option)
      return
    }
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      event.stopPropagation()
      close()
    }
  }

  return (
    <div
      ref={rootRef}
      data-slot="combobox-field-input"
      data-open={open || undefined}
      className={cn('relative w-full max-w-sm font-sans', className)}
    >
      <label htmlFor={fieldId} className={hideLabel ? 'sr-only' : 'mb-1.5 block text-sm font-medium text-neutral-900'}>{label}</label>
      <div className="relative">
        <input
          ref={inputRef}
          id={fieldId}
          type="text"
          role="combobox"
          autoComplete="off"
          disabled={disabled}
          value={displayValue}
          placeholder={placeholder}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-activedescendant={open && highlighted >= 0 ? `${listboxId}-option-${highlighted}` : undefined}
          onChange={handleInputChange}
          onFocus={() => openList()}
          onBlur={() => { blurTimerRef.current = window.setTimeout(() => close(), 120) }}
          onKeyDown={handleKeyDown}
          className={cn(
            'h-8 w-full rounded-lg border bg-white py-1 pr-9 pl-3 font-sans text-xs text-neutral-900 outline-none transition-[border-color] duration-200 placeholder:text-neutral-400 disabled:cursor-not-allowed disabled:bg-neutral-50 disabled:text-neutral-400',
            open ? 'border-neutral-900' : 'border-neutral-200 focus:border-neutral-900',
          )}
        />
        <ChevronDown
          size={14}
          strokeWidth={2}
          aria-hidden
          className={cn('pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-neutral-400 transition-transform duration-200', open && 'rotate-180')}
        />
      </div>
      {open ? (
        <ul
          id={listboxId}
          role="listbox"
          aria-label={label}
          className="absolute z-20 mt-1.5 max-h-56 w-full overflow-auto rounded-lg border border-neutral-200 bg-white py-1 shadow-sm"
        >
          {filtered.length === 0 ? (
            <li className="px-3 py-2 text-xs text-neutral-400">{emptyMessage}</li>
          ) : filtered.map((option, index) => {
            const isSelected = option.value === value
            const isHighlighted = index === highlighted
            return (
              <li
                key={option.value}
                id={`${listboxId}-option-${index}`}
                role="option"
                aria-selected={isSelected}
                aria-disabled={option.disabled || undefined}
                onMouseEnter={() => { if (!option.disabled) setHighlighted(index) }}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => selectOption(option)}
                className={cn(
                  'flex cursor-pointer items-center justify-between gap-2 px-3 py-1.5 text-xs transition-colors duration-150',
                  option.disabled && 'cursor-not-allowed text-neutral-300',
                  !option.disabled && isHighlighted && 'bg-neutral-50 text-neutral-900',
                  !option.disabled && !isHighlighted && 'text-neutral-700',
                  isSelected && !option.disabled && 'font-medium text-neutral-900',
                )}
              >
                <span className="truncate">{option.label}</span>
                {isSelected ? <Check size={12} strokeWidth={2.5} className="shrink-0 text-neutral-900" /> : null}
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}
