import type { ReactNode } from 'react'
import { cn } from './cn'

/** Page or settings section title from docs/desktop.pen (`Settings/Section Header`). */
export function SectionHeader({
  title,
  description,
  id,
  as: Heading = 'h2',
  actions,
  className,
}: {
  title: ReactNode
  description?: ReactNode
  id?: string
  as?: 'h1' | 'h2' | 'h3'
  actions?: ReactNode
  className?: string
}) {
  return (
    <div data-slot="section-header" className={cn('flex w-full items-start gap-4', className)}>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Heading id={id} className="m-0 text-lg leading-6 font-normal text-ink">{title}</Heading>
        {description ? <p className="m-0 text-[13px] leading-[1.45] text-moss">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  )
}
