import { useId, type ReactNode } from 'react'
import { cn } from './cn'
import { Switch } from './Switch'

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
        <Switch
          id={id}
          checked={checked}
          disabled={disabled}
          aria-label={switchAriaLabel}
          aria-labelledby={switchAriaLabel ? undefined : `${id}-label`}
          aria-describedby={hint ? hintId : undefined}
          onCheckedChange={onCheckedChange}
        />
        {actions}
      </div>
    </div>
  )
}
