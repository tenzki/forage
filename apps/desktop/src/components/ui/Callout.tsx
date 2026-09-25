import type { ReactNode } from 'react'
import { Info, ShieldAlert } from 'lucide-react'
import { cn } from './cn'

export type CalloutTone = 'caution' | 'info'

const TONES: Record<CalloutTone, { box: string; title: string; icon: ReactNode }> = {
  caution: { box: 'bg-clay-soft', title: 'text-clay', icon: <ShieldAlert size={16} className="text-clay" aria-hidden="true" /> },
  info: { box: 'bg-paper-sunk', title: 'text-ink', icon: <Info size={16} className="text-moss" aria-hidden="true" /> },
}

/** Inline note from docs/desktop.pen (`Callout/Caution`, `Callout/Info`). */
export function Callout({
  tone = 'info',
  title,
  icon,
  role = 'note',
  className,
  children,
}: {
  tone?: CalloutTone
  title: ReactNode
  icon?: ReactNode
  role?: string
  className?: string
  children?: ReactNode
}) {
  const style = TONES[tone]
  return (
    <div
      role={role}
      data-slot="callout"
      data-tone={tone}
      className={cn('flex w-full items-start gap-2.5 rounded-md px-3.5 py-3', style.box, className)}
    >
      <span className="mt-px flex shrink-0">{icon ?? style.icon}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <strong className={cn('text-[13px] leading-[18px] font-normal', style.title)}>{title}</strong>
        {children ? <div className="text-xs leading-[1.45] text-ink-soft [&_p]:m-0">{children}</div> : null}
      </div>
    </div>
  )
}
