import { TriangleAlert, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from './cn'

/** Dismissible error strip from docs/desktop.pen (`Alert Banner`). */
export function AlertBanner({
  title,
  description,
  onDismiss,
  className,
}: {
  title: ReactNode
  description?: ReactNode
  onDismiss?: () => void
  className?: string
}) {
  return (
    <div
      data-slot="alert-banner"
      className={cn('relative flex w-full items-start gap-2.5 rounded-md bg-clay-soft px-3 py-2.5', className)}
    >
      <TriangleAlert size={16} className="mt-px shrink-0 text-clay" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-[13px] leading-[18px] text-clay">{title}</p>
        {description ? <p className="text-xs leading-[1.45] text-ink-soft">{description}</p> : null}
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="-mt-1 -mr-1.5 flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-sm text-moss outline-none transition-colors hover:bg-black/5 hover:text-ink focus-visible:outline-2 focus-visible:outline-violet"
        >
          <X size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  )
}
