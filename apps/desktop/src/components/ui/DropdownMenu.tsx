import { forwardRef, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { cn } from './cn'

export const DropdownMenu = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<'div'>>(function DropdownMenu({ className, ...props }, ref) {
  return (
    <div
      ref={ref}
      data-slot="dropdown-menu"
      data-origin="top-left"
      className={cn(
        't-dropdown is-open fixed z-80 flex w-52 flex-col rounded-[10px] border border-neutral-300 bg-white p-1 font-sans shadow-[0_8px_24px_rgba(32,61,50,0.12)]',
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
        'flex w-full cursor-pointer items-center justify-between gap-4 rounded-sm px-2.5 py-2 text-left text-[13px] font-normal outline-none transition-colors',
        danger ? 'text-red-600 hover:bg-red-50 focus-visible:bg-red-50' : 'text-neutral-900 hover:bg-neutral-50 focus-visible:bg-neutral-50',
        className,
      )}
      {...props}
    >
      <span className="flex min-w-0 items-center gap-2">
        {Icon ? <Icon size={14} strokeWidth={1.8} aria-hidden="true" className={danger ? 'text-red-400' : 'text-neutral-500'} /> : null}
        <span className="truncate">{children}</span>
      </span>
      {shortcut ? <kbd aria-hidden="true" className="shrink-0 font-mono text-[9px] text-neutral-400">{shortcut}</kbd> : null}
    </button>
  )
}

export function DropdownMenuSeparator() {
  return <hr className="mx-1 my-1 h-px border-0 bg-neutral-100" />
}
