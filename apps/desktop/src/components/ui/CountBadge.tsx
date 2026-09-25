import type { ComponentPropsWithoutRef } from 'react'
import { cn } from './cn'

/**
 * Small mono count pill from docs/desktop.pen (`Count Badge`). The `attention`
 * tone marks counts that need action, such as extensions awaiting review.
 */
export function CountBadge({
  tone = 'default',
  className,
  ...props
}: ComponentPropsWithoutRef<'span'> & { tone?: 'default' | 'attention' }) {
  return (
    <span
      data-slot="count-badge"
      className={cn(
        'inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-[9px] px-1.5 font-mono text-[10px] leading-none tabular-nums',
        tone === 'attention' ? 'bg-clay-soft text-clay' : 'bg-paper-sunk text-moss',
        className,
      )}
      {...props}
    />
  )
}
