import { useRef, type InputHTMLAttributes } from 'react'
import { cn } from './cn'

export interface SwitchProps extends Pick<InputHTMLAttributes<HTMLInputElement>, 'id' | 'aria-label' | 'aria-labelledby' | 'aria-describedby'> {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled?: boolean
  className?: string
}

// The toggle track from OpenSourceUI's SwitchFieldInput (MIT), usable without the field row.
export function Switch({ checked, onCheckedChange, disabled = false, className, ...inputProps }: SwitchProps) {
  const hasInteracted = useRef(false)

  return (
    <label className={cn(
      'relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-forage-600',
      disabled && 'cursor-not-allowed opacity-50',
      className,
    )}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => {
          hasInteracted.current = true
          onCheckedChange(event.target.checked)
        }}
        className="peer sr-only"
        {...inputProps}
      />
      <span
        aria-hidden="true"
        data-on={String(checked)}
        className={cn(
          't-toggle absolute inset-0 rounded-full border-2 transition-[background-color,border-color] duration-200 peer-checked:border-neutral-900 peer-checked:bg-neutral-900 [--toggle-travel:20px]',
          hasInteracted.current && 'is-init',
          checked ? 'border-neutral-900 bg-neutral-900' : 'border-neutral-200 bg-neutral-100',
        )}
      >
        <span className="t-toggle-thumb pointer-events-none absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow-xs" />
      </span>
    </label>
  )
}
