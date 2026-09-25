import type { ReactNode } from 'react'
import { cn } from './cn'

/** Centered placeholder from docs/desktop.pen (`Activity/Empty`). */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  className?: string
}) {
  return (
    <div data-slot="empty-state" className={cn('flex w-full flex-col items-center gap-1.5 px-4 py-8 text-center', className)}>
      {icon ? <span aria-hidden="true" className="mb-0.5 flex text-moss [&_svg]:size-5">{icon}</span> : null}
      <p className="m-0 text-[13px] leading-[18px] text-ink">{title}</p>
      {description ? <p className="m-0 text-xs leading-[1.45] text-moss">{description}</p> : null}
      {action ? <div className="mt-2.5">{action}</div> : null}
    </div>
  )
}
