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
        'flex size-[30px] shrink-0 cursor-pointer items-center justify-center rounded-md border border-transparent outline-none transition-[background-color,color,transform,opacity] duration-200 focus-visible:border-neutral-300 focus-visible:bg-white disabled:cursor-default disabled:opacity-45',
        active ? 'bg-sage text-neutral-900' : 'text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  )
}
