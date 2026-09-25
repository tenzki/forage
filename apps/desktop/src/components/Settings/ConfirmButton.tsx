import { useState } from 'react'
import { Button, type ButtonSize, type ButtonVariant } from '../ui/Button'

interface ConfirmButtonProps {
  label: string
  confirmLabel: string
  onConfirm: () => void
  className?: string
  variant?: ButtonVariant
  size?: ButtonSize
  ariaLabel?: string
  confirmAriaLabel?: string
  disabled?: boolean
}

export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  className,
  variant = 'secondary',
  size = 'md',
  ariaLabel,
  confirmAriaLabel,
  disabled = false,
}: ConfirmButtonProps) {
  const [confirming, setConfirming] = useState(false)

  return (
    <Button
      variant={variant}
      size={size}
      className={className}
      aria-label={confirming ? confirmAriaLabel : ariaLabel}
      disabled={disabled}
      onBlur={() => setConfirming(false)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setConfirming(false)
      }}
      onClick={() => {
        if (!confirming) {
          setConfirming(true)
          return
        }
        setConfirming(false)
        onConfirm()
      }}
    >
      {confirming ? confirmLabel : label}
    </Button>
  )
}
