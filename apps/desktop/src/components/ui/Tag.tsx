import type { ComponentPropsWithoutRef } from 'react'
import { cn } from './cn'

/** Sage `#tag` chip from docs/desktop.pen (`Tag`). */
export function Tag({ className, ...props }: ComponentPropsWithoutRef<'span'>) {
  return (
    <span
      data-slot="tag"
      className={cn('inline-flex items-center gap-0.5 rounded-sm bg-sage px-[7px] py-0.5 text-xs leading-4 text-ink', className)}
      {...props}
    />
  )
}
