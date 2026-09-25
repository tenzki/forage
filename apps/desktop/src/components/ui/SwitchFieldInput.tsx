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

// Adapted from OpenSourceUI's SwitchFieldInput (MIT); styled as `Settings/Switch Row` in docs/desktop.pen.
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
      className={cn('flex w-full items-center justify-between gap-4 border-b border-rule-soft bg-paper-raised px-4 py-3 last:border-b-0', className)}
    >
      <div className="min-w-0 flex-1">
        <p id={`${id}-label`} className="text-sm leading-5 font-normal text-ink">{label}</p>
        {hint ? <div id={hintId} className="mt-[3px] text-xs leading-[1.45] text-moss">{hint}</div> : null}
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
