import { useCallback, useEffect, useState } from 'react'
import { NativeEventRepository } from '../../persistence/eventStore'
import { useMcpStore } from '../../store/mcpStore'

/** Use the same persisted mode as skill execution, never connection reachability. */
export function useMcpConnections() {
  const local = useMcpStore((state) => state.connections)
  const server = useMcpStore((state) => state.serverConnections)
  const [environment, setEnvironment] = useState<'local' | 'server' | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const reload = useCallback(() => setRevision((value) => value + 1), [])
  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    void (async () => {
      const mode = await new NativeEventRepository().storageMode()
      if (mode !== 'local' && mode !== 'server') throw new Error('Could not determine where agents run.')
      if (!active) return
      setEnvironment(mode)
      const store = useMcpStore.getState()
      if (mode === 'server') await store.loadServer()
      else if (!store.loaded) await store.load()
    })().catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : 'Could not load MCP servers.')
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [revision])
  return { environment, loading, error, reload, connections: loading || error ? [] : environment === 'server' ? server : local }
}
