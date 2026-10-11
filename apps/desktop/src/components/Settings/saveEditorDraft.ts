import { useRef } from 'react'
import { publishLocalAgentConfiguration } from '../../agent/serverConfigurationSync'

export function usePublishedDraft<T>(saveLocal: (draft: T) => Promise<void>, session: unknown) {
  const saved = useRef<string | null>(null)
  const active = useRef(session)
  if (active.current !== session) { active.current = session; saved.current = null }
  return async (draft: T) => {
    const signature = JSON.stringify(draft)
    if (saved.current !== signature) {
      await saveLocal(draft)
      saved.current = signature
    }
    try { await publishLocalAgentConfiguration() }
    catch { throw new Error('Saved on this device, but not published to the server. Keep this draft open and retry Save to publish it.') }
  }
}
