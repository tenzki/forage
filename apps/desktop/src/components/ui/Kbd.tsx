import type { ComponentPropsWithoutRef } from 'react'
import { cn } from './cn'

/** Keyboard key hint from docs/desktop.pen (`Kbd`). */
export function Kbd({ className, ...props }: ComponentPropsWithoutRef<'kbd'>) {
  return (
    <kbd
      data-slot="kbd"
      className={cn('inline-flex shrink-0 items-center rounded-sm border border-rule-soft bg-paper-sunk px-[5px] py-0.5 font-mono text-[10px] leading-3 text-moss', className)}
      {...props}
    />
  )
}
