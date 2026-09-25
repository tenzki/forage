import type { ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { cn } from './cn'

const ROW = 'flex w-full items-center border-b border-rule-soft bg-paper-raised px-4 py-3 text-left last:border-b-0'

function RowCopy({ title, description, meta }: { title: ReactNode; description?: ReactNode; meta?: ReactNode }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
      <span className="truncate text-sm leading-5 text-ink">{title}</span>
      {description ? <span className="text-xs leading-[1.45] text-moss">{description}</span> : null}
      {meta ? <span className="font-mono text-[10px] leading-[14px] tracking-[0.02em] text-moss uppercase">{meta}</span> : null}
    </span>
  )
}

/**
 * A settings list entry from docs/desktop.pen (`Settings/List Row`, `Extension/Row`).
 * With `onClick` the whole row is a button and gets a trailing chevron;
 * otherwise `actions` render on the right.
 */
export function ListRow({
  title,
  description,
  meta,
  leading,
  status,
  actions,
  onClick,
  ariaLabel,
  className,
}: {
  title: ReactNode
  description?: ReactNode
  meta?: ReactNode
  /** Icon shown in a 32px sage badge. */
  leading?: ReactNode
  status?: ReactNode
  actions?: ReactNode
  onClick?: () => void
  ariaLabel?: string
  className?: string
}) {
  const body = (
    <>
      {leading ? <span aria-hidden="true" className="flex size-8 shrink-0 items-center justify-center rounded-md bg-sage text-ink [&_svg]:size-4">{leading}</span> : null}
      <RowCopy title={title} description={description} meta={meta} />
      {status}
    </>
  )
  if (onClick) {
    return (
      <button
        type="button"
        data-slot="list-row"
        aria-label={ariaLabel}
        onClick={onClick}
        className={cn(ROW, 'cursor-pointer gap-3.5 outline-none transition-colors hover:bg-paper focus-visible:bg-paper focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-violet', className)}
      >
        {body}
        <ChevronRight size={15} className="shrink-0 text-moss" aria-hidden="true" />
      </button>
    )
  }
  return (
    <div data-slot="list-row" className={cn(ROW, leading ? 'gap-3.5' : 'gap-4', className)}>
      {body}
      {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
    </div>
  )
}

/** Term/value pair from docs/desktop.pen (`Settings/Definition`). */
export function DefinitionRow({ term, children, mono = true, className }: { term: ReactNode; children: ReactNode; mono?: boolean; className?: string }) {
  return (
    <div data-slot="definition-row" className={cn('flex w-full gap-4 border-b border-rule-soft py-2', className)}>
      <dt className="w-[140px] shrink-0 text-xs leading-[1.45] text-moss">{term}</dt>
      <dd className={cn('m-0 min-w-0 flex-1 text-xs leading-[1.45] break-words text-ink', mono && 'font-mono')}>{children}</dd>
    </div>
  )
}
