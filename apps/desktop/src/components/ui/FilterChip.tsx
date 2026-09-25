import type { ComponentPropsWithoutRef } from 'react'
import { cn } from './cn'

/** Toggleable pill from docs/desktop.pen (`Filter Chip`, `Filter Chip/Active`). */
export function FilterChip({
  active = false,
  className,
  type = 'button',
  ...props
}: ComponentPropsWithoutRef<'button'> & { active?: boolean }) {
  return (
    <button
      type={type}
      data-slot="filter-chip"
      aria-pressed={active}
      className={cn(
        'inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-xl border px-2.5 py-1 text-xs leading-4 whitespace-nowrap outline-none transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet disabled:cursor-default disabled:opacity-45',
        active ? 'border-ink bg-ink text-paper' : 'border-rule bg-transparent text-ink-soft hover:enabled:bg-paper-sunk hover:enabled:text-ink',
        className,
      )}
      {...props}
    />
  )
}
