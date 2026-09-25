import type { ReactNode } from 'react'
import { Check, X } from 'lucide-react'
import { cn } from './cn'

/**
 * Status pills from docs/desktop.pen (`Status/*` and `Extension Status/*`).
 * `running` shows a pulsing dot, `success` a check and `danger` a cross;
 * pass `icon={false}` for the text-only extension variants, or an element to
 * replace the default glyph.
 */
export type StatusTone = 'running' | 'success' | 'danger' | 'muted'

const TONES: Record<StatusTone, string> = {
  running: 'bg-lilac text-violet',
  success: 'bg-sage text-ink',
  danger: 'bg-clay-soft text-clay',
  muted: 'bg-paper-sunk text-moss',
}

export function StatusPill({
  tone,
  icon = true,
  className,
  children,
}: {
  tone: StatusTone
  icon?: boolean | ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <span
      data-slot="status-pill"
      data-tone={tone}
      className={cn('inline-flex shrink-0 items-center gap-1.5 rounded-[9px] px-2 py-[3px] text-[11px] leading-[13px] whitespace-nowrap', TONES[tone], className)}
    >
      {typeof icon !== 'boolean' && icon != null && <span aria-hidden="true" className="flex [&_svg]:size-[11px]">{icon}</span>}
      {icon === true && tone === 'running' && <span aria-hidden="true" className="size-1.5 animate-pulse rounded-full bg-violet" />}
      {icon === true && tone === 'success' && <Check size={11} strokeWidth={2} aria-hidden="true" />}
      {icon === true && tone === 'danger' && <X size={11} strokeWidth={2} aria-hidden="true" />}
      {children}
    </span>
  )
}
