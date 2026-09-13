/**
 * Whether the outline stream is currently delivering server changes.
 *
 * Observers that would otherwise poll read this to decide how long to wait:
 * while the stream is live nothing needs asking, so a request is only worth
 * making to catch a socket that died without saying so.
 */
export type StreamLiveness =
  /** Connected; changes arrive as frames. */
  | 'live'
  /** Disconnected, reconnecting. */
  | 'down'
  /** No stream will arrive: the server does not offer one, or refused it. */
  | 'unsupported'

export class StreamLivenessTracker {
  private value: StreamLiveness = 'down'
  private readonly listeners = new Set<(value: StreamLiveness) => void>()

  get(): StreamLiveness { return this.value }

  set(value: StreamLiveness): void {
    if (this.value === value) return
    this.value = value
    for (const listener of [...this.listeners]) listener(value)
  }

  subscribe(listener: (value: StreamLiveness) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}

export const streamLiveness = new StreamLivenessTracker()
