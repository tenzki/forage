import { useId, type ReactNode } from 'react'
import { cn } from './cn'

export interface SwitchFieldInputProps {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  label: string
  hint?: ReactNode
  disabled?: boolean
  className?: string
  switchAriaLabel?: string
  actions?: ReactNode
}

// Adapted from OpenSourceUI's SwitchFieldInput (MIT) for Forage settings rows.
export function SwitchFieldInput({
  checked,
  onCheckedChange,
  label,
  hint,
  disabled = false,
  className,
  switchAriaLabel,
  actions,
}: SwitchFieldInputProps) {
  const id = useId()
  const hintId = `${id}-hint`

  return (
    <div
      data-slot="switch-field-input"
      data-checked={checked || undefined}
      className={cn('flex w-full items-start justify-between gap-4 rounded-xl px-3 py-3 transition-colors hover:bg-neutral-50', className)}
    >
      <div className="min-w-0 flex-1">
        <p id={`${id}-label`} className="text-sm font-medium text-neutral-900">{label}</p>
        {hint ? <div id={hintId} className="mt-0.5 text-xs leading-5 text-neutral-500">{hint}</div> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <label className={cn(
          'relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-forage-600',
          disabled && 'cursor-not-allowed opacity-50',
        )}>
          <input
            id={id}
            type="checkbox"
            checked={checked}
            disabled={disabled}
            aria-label={switchAriaLabel}
            aria-labelledby={switchAriaLabel ? undefined : `${id}-label`}
            aria-describedby={hint ? hintId : undefined}
            onChange={(event) => onCheckedChange(event.target.checked)}
            className="peer sr-only"
          />
          <span
            aria-hidden="true"
            className={cn(
              'absolute inset-0 rounded-full border-2 transition-[background-color,border-color] duration-200 peer-checked:border-neutral-900 peer-checked:bg-neutral-900',
              checked ? 'border-neutral-900 bg-neutral-900' : 'border-neutral-200 bg-neutral-100',
            )}
          >
            <span
              className={cn(
                'pointer-events-none absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow-xs transition-transform duration-200 motion-reduce:transition-none',
                checked && 'translate-x-5',
              )}
            />
          </span>
        </label>
        {actions}
      </div>
    </div>
  )
}
