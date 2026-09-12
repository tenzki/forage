import { AlertTriangle, X } from 'lucide-react'
import { cn } from './cn'

export function SystemAlertBanner({
  title,
  description,
  onDismiss,
  tone = 'error',
  className,
}: {
  title: string
  description: string
  onDismiss: () => void
  tone?: 'error' | 'warning'
  className?: string
}) {
  return (
    <div
      role="alert"
      data-slot="system-alert-banner"
      className={cn(
        'fixed top-5 right-5 z-120 block w-[min(22rem,calc(100vw-2.5rem))] overflow-hidden rounded-2xl border border-white/70 bg-white/95 font-sans shadow-[0_12px_36px_-8px_rgba(0,0,0,0.2)] backdrop-blur-xl',
        'animate-[forage-alert-in_240ms_cubic-bezier(0.22,1,0.36,1)] motion-reduce:animate-none',
        className,
      )}
    >
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        className="absolute top-2 right-2 z-1 flex size-7 cursor-pointer items-center justify-center rounded-full text-neutral-400 transition-colors hover:bg-black/5 hover:text-neutral-700 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-neutral-900"
      >
        <X size={12} aria-hidden="true" />
      </button>
      <div className="grid grid-cols-[2.25rem_minmax(0,1fr)] items-start gap-x-3 px-3.5 py-3.5 pr-10">
        <span className={cn(
          'flex size-9 items-center justify-center rounded-[0.625rem] text-white shadow-sm',
          tone === 'error' ? 'bg-red-500' : 'bg-amber-400',
        )}>
          <AlertTriangle size={17} strokeWidth={2} aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <p className="text-[13px] leading-tight font-semibold text-neutral-900">{title}</p>
          <p className="mt-1 text-[13px] leading-[1.4] text-neutral-600">{description}</p>
        </div>
      </div>
    </div>
  )
}
