import { useState } from 'react'

interface ConfirmButtonProps {
  label: string
  confirmLabel: string
  onConfirm: () => void
  className?: string
  ariaLabel?: string
  confirmAriaLabel?: string
}

export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
  className = '',
  ariaLabel,
  confirmAriaLabel,
}: ConfirmButtonProps) {
  const [confirming, setConfirming] = useState(false)

  return (
    <button
      type="button"
      className={`danger-action ${className}`.trim()}
      aria-label={confirming ? confirmAriaLabel : ariaLabel}
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
    </button>
  )
}
