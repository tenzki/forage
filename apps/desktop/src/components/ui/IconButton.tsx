import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import { cn } from './cn'

export function IconButton({
  label,
  children,
  active = false,
  className,
  ...props
}: Omit<ComponentPropsWithoutRef<'button'>, 'aria-label'> & {
  label: string
  children: ReactNode
  active?: boolean
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={props.title ?? label}
      className={cn(
        'flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg border border-transparent outline-none transition-[background-color,color,transform] duration-200 focus-visible:border-neutral-300 focus-visible:bg-white focus-visible:shadow-sm disabled:cursor-default disabled:text-neutral-300',
        active ? 'bg-neutral-900 text-white shadow-sm' : 'text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  )
}
