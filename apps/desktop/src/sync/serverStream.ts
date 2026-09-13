import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { z } from 'zod'
import { outlineStreamServerFrameSchema } from '@forage/protocol'
import type { EventEnvelope } from '@forage/domain'

/** Lifecycle frames the Rust stream client raises itself. */
const streamLifecycleFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('stream_connected') }),
  z.object({ type: z.literal('stream_disconnected'), reason: z.string() }),
  z.object({ type: z.literal('stream_auth_failed'), status: z.number() }),
])

export interface ServerStreamHandlers {
  /** A contiguous run of authoritative events following `fromRevision`. */
  onBatch(batch: { fromRevision: number; toRevision: number; events: EventEnvelope[] }): void
  /** The local cursor can no longer be trusted; pull instead. */
  onResync(): void
  onAgent(signal: { runId: string; activitySeq: number; status: string }): void
  /** The server refused the stream in a way retrying cannot fix. */
  onAuthFailed(status: number): void
  /**
   * The socket is up. Time passed while it was down, so nothing the client
   * holds can be assumed current.
   */
  onConnected?(): void
  onDisconnected?(reason: string): void
}

const STREAM_EVENT = 'server:stream'

/**
 * Opens the outline stream and relays its frames.
 *
 * The socket itself lives in Rust, which holds the server credential and the
 * pinned origin; this module only interprets the frames it forwards.
 */
export async function connectServerStream(
  afterRevision: number,
  handlers: ServerStreamHandlers,
): Promise<() => void> {
  const unlisten = await listen<unknown>(STREAM_EVENT, (event) => {
    dispatchStreamFrame(event.payload, handlers)
  })
  try {
    await invoke('server_stream_connect', { afterRevision })
  } catch (error) {
    unlisten()
    throw error
  }
  return () => {
    unlisten()
    void invoke('server_stream_disconnect').catch(() => undefined)
  }
}

/** Exported for testing: routes one relayed frame to the matching handler. */
export function dispatchStreamFrame(payload: unknown, handlers: ServerStreamHandlers): void {
  const frame = outlineStreamServerFrameSchema.safeParse(payload)
  if (frame.success) {
    switch (frame.data.type) {
      case 'events':
        handlers.onBatch({
          fromRevision: frame.data.fromRevision,
          toRevision: frame.data.toRevision,
          events: frame.data.events as EventEnvelope[],
        })
        return
      case 'resync':
        handlers.onResync()
        return
      case 'agent':
        handlers.onAgent({
          runId: frame.data.runId,
          activitySeq: frame.data.activitySeq,
          status: frame.data.status,
        })
        return
      default:
        return
    }
  }
  const lifecycle = streamLifecycleFrameSchema.safeParse(payload)
  if (!lifecycle.success) return
  switch (lifecycle.data.type) {
    case 'stream_connected':
      handlers.onConnected?.()
      return
    case 'stream_disconnected':
      handlers.onDisconnected?.(lifecycle.data.reason)
      return
    case 'stream_auth_failed':
      handlers.onAuthFailed(lifecycle.data.status)
  }
}
