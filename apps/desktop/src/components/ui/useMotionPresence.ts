import { useEffect, useState } from 'react'

export type MotionPresenceState = 'is-open' | 'is-closing'

export function useMotionPresence(open: boolean, closeMs: number): {
  mounted: boolean
  motionState: MotionPresenceState
} {
  const [mounted, setMounted] = useState(open)
  const [closing, setClosing] = useState(false)

  useEffect(() => {
    if (open) {
      setMounted(true)
      setClosing(false)
      return
    }
    if (!mounted) return
    setClosing(true)
    const timer = window.setTimeout(() => {
      setMounted(false)
      setClosing(false)
    }, closeMs)
    return () => window.clearTimeout(timer)
  }, [closeMs, mounted, open])

  return { mounted, motionState: closing ? 'is-closing' : 'is-open' }
}
