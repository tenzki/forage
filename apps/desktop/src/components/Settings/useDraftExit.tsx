import { useEffect, useRef, useState } from 'react'
import { Button } from '../ui/Button'
import { useSettingsNavigation } from './settingsNavigation'

export function useDraftExit(dirty: boolean, busy: boolean, onCancel: () => void) {
  const navigation = useSettingsNavigation()
  const state = useRef({ dirty, busy })
  state.current = { dirty, busy }
  const [pending, setPending] = useState<(() => void) | null>(null)
  const request = (action: () => void) => {
    if (state.current.busy) return
    if (state.current.dirty) setPending(() => action)
    else action()
  }
  useEffect(() => navigation?.registerGuard(request), [navigation])
  return {
    cancel: () => request(onCancel),
    allowExit: () => { state.current = { dirty: false, busy: false } },
    dialog: pending && <div role="alertdialog" aria-label="Discard unsaved changes?" className="auth-card">
      <p>Discard unsaved changes?</p>
      <Button autoFocus onClick={() => setPending(null)}>Keep editing</Button>
      <Button variant="danger" onClick={() => { state.current.dirty = false; setPending(null); pending() }}>Discard changes</Button>
    </div>,
  }
}
