import { AlertBanner } from './AlertBanner'
import { cn } from './cn'
import type { MotionPresenceState } from './useMotionPresence'

/** A floating `AlertBanner` pinned to the window's top-right corner. */
export function SystemAlertBanner({
  title,
  description,
  onDismiss,
  className,
  motionState = 'is-open',
}: {
  title: string
  description: string
  onDismiss: () => void
  className?: string
  motionState?: MotionPresenceState
}) {
  return (
    <div
      role="alert"
      data-slot="system-alert-banner"
      className={cn(
        'fixed top-5 right-5 z-120 block w-[min(22rem,calc(100vw-2.5rem))] overflow-hidden rounded-md font-sans shadow-[0_12px_32px_-12px_rgba(32,61,50,0.32)]',
        `t-toast ${motionState}`,
        className,
      )}
    >
      <AlertBanner title={title} description={description} onDismiss={onDismiss} />
    </div>
  )
}
