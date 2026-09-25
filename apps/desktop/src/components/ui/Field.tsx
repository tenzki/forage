import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from './cn'

const CONTROL = 'w-full rounded-md border border-rule bg-paper-raised px-2.5 text-ink outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-neutral-400 hover:enabled:border-neutral-400 focus:border-ink-soft focus:shadow-[0_0_0_3px_rgba(112,87,163,0.14)] disabled:cursor-not-allowed disabled:bg-paper-sunk disabled:text-moss'

const LABEL = 'text-xs leading-4 font-normal text-ink-soft'

/**
 * Labelled control from docs/desktop.pen (`Field`). Wrap the control, or pass
 * `htmlFor` with the control's `id` when the label must stay a sibling.
 */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  className,
  children,
}: {
  label: ReactNode
  htmlFor?: string
  hint?: ReactNode
  error?: ReactNode
  className?: string
  children: ReactNode
}) {
  const note = error
    ? <span className="block text-xs leading-[1.45] text-clay" role="alert">{error}</span>
    : hint ? <span className="block text-xs leading-[1.45] text-moss">{hint}</span> : null
  const classes = cn('flex w-full flex-col gap-1.5', className)
  if (htmlFor) {
    return (
      <div data-slot="field" className={classes}>
        <label htmlFor={htmlFor} className={LABEL}>{label}</label>
        {children}
        {note}
      </div>
    )
  }
  return (
    <label data-slot="field" className={classes}>
      <span className={LABEL}>{label}</span>
      {children}
      {note}
    </label>
  )
}

export function Input({ className, mono = false, ...props }: ComponentPropsWithoutRef<'input'> & { mono?: boolean }) {
  return <input data-slot="input" className={cn(CONTROL, 'h-[34px]', mono ? 'font-mono text-xs' : 'text-[13px]', className)} {...props} />
}

export function Textarea({ className, mono = false, ...props }: ComponentPropsWithoutRef<'textarea'> & { mono?: boolean }) {
  return <textarea data-slot="textarea" className={cn(CONTROL, 'min-h-20 resize-y py-2 leading-[1.45]', mono ? 'font-mono text-xs' : 'text-[13px]', className)} {...props} />
}

/** Native select dressed as `Dropdown/Trigger`. */
export function Select({ className, mono = false, ...props }: ComponentPropsWithoutRef<'select'> & { mono?: boolean }) {
  return (
    <span className="relative flex w-full">
      <select
        data-slot="select"
        className={cn(CONTROL, 'h-[34px] cursor-pointer appearance-none pr-8', mono ? 'font-mono text-xs' : 'text-[13px]', className)}
        {...props}
      />
      <ChevronDown size={14} className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-moss" aria-hidden="true" />
    </span>
  )
}
