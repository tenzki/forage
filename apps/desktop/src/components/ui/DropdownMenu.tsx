import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from './cn'

export const DropdownMenu = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<'div'>>(function DropdownMenu({ className, ...props }, ref) {
  return (
    <div
      ref={ref}
      data-slot="dropdown-menu"
      className={cn(
        'fixed z-80 flex w-52 flex-col rounded-xl border border-neutral-200 bg-white p-1 font-sans shadow-[0_18px_50px_-12px_rgba(0,0,0,0.22)]',
        className,
      )}
      {...props}
    />
  )
})

DropdownMenu.displayName = 'DropdownMenu'

export function DropdownMenuItem({
  icon: Icon,
  danger = false,
  shortcut,
  children,
  className,
  ...props
}: ComponentPropsWithoutRef<'button'> & {
  icon?: LucideIcon
  danger?: boolean
  shortcut?: string
  children: ReactNode
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className={cn(
        'flex w-full cursor-pointer items-center justify-between gap-4 rounded-lg px-2.5 py-2 text-left text-xs font-medium outline-none transition-colors',
        danger ? 'text-red-600 hover:bg-red-50 focus-visible:bg-red-50' : 'text-neutral-700 hover:bg-neutral-50 focus-visible:bg-neutral-100',
        className,
      )}
      {...props}
    >
      <span className="flex min-w-0 items-center gap-2">
        {Icon ? <Icon size={14} strokeWidth={1.8} aria-hidden="true" className={danger ? 'text-red-400' : 'text-neutral-400'} /> : null}
        <span className="truncate">{children}</span>
      </span>
      {shortcut ? <kbd className="shrink-0 font-mono text-[9px] text-neutral-400">{shortcut}</kbd> : null}
    </button>
  )
}

export function DropdownMenuSeparator() {
  return <hr className="mx-1 my-1 h-px border-0 bg-neutral-100" />
}
