import type { ReactNode } from 'react'
import { CircleCheck, CircleDashed, CircleX, LoaderCircle } from 'lucide-react'
import { cn } from './cn'

export type ResultState = 'ok' | 'error' | 'pending' | 'unchecked'

const STATE_ICON: Record<ResultState, ReactNode> = {
  ok: <CircleCheck size={16} className="shrink-0 text-moss" aria-hidden="true" />,
  error: <CircleX size={16} className="shrink-0 text-clay" aria-hidden="true" />,
  pending: <LoaderCircle size={16} className="shrink-0 animate-spin text-moss" aria-hidden="true" />,
  unchecked: <CircleDashed size={16} className="shrink-0 text-moss" aria-hidden="true" />,
}

const TITLE_TONE: Record<ResultState, string> = {
  ok: 'text-ink',
  error: 'text-clay',
  pending: 'text-ink',
  unchecked: 'text-ink-soft',
}

/**
 * A check outcome line from docs/desktop.pen (`Settings/Runtime Result`).
 * `detail` sits on the right (a version); `error` explains a failure below the title.
 */
export function ResultRow({
  state,
  title,
  detail,
  error,
  className,
}: {
  state: ResultState
  title: ReactNode
  detail?: ReactNode
  error?: ReactNode
  className?: string
}) {
  return (
    <div
      data-slot="result-row"
      data-state={state}
      className={cn('flex w-full gap-3 border-b border-rule-soft py-2.5 last:border-b-0', error ? 'items-start' : 'items-center', className)}
    >
      {STATE_ICON[state]}
      <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
        <span className={cn('text-[13px] leading-[18px]', TITLE_TONE[state])}>{title}</span>
        {error ? <span className="font-mono text-[11px] leading-[1.45] break-words text-ink-soft">{error}</span> : null}
      </div>
      {detail ? <span className="shrink-0 font-mono text-[11px] text-moss">{detail}</span> : null}
    </div>
  )
}
