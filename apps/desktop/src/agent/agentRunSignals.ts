import type { StreamLiveness } from '../sync/streamLiveness'

export class AgentRunSignals {
  private readonly waiters = new Map<string, Set<() => void>>()

  notify(runId: string): void {
    for (const release of [...(this.waiters.get(runId) ?? [])]) release()
  }

  notifyAll(): void {
    for (const listeners of [...this.waiters.values()]) {
      for (const release of [...listeners]) release()
    }
  }

  wait(runId: string): { promise: Promise<void>; cancel: () => void } {
    let release: () => void = () => undefined
    const promise = new Promise<void>((resolve) => { release = resolve })
    const listeners = this.waiters.get(runId) ?? new Set()
    listeners.add(release)
    this.waiters.set(runId, listeners)
    return {
      promise,
      cancel: () => {
        listeners.delete(release)
        if (listeners.size === 0) this.waiters.delete(runId)
      },
    }
  }

  waiting(runId: string): number {
    return this.waiters.get(runId)?.size ?? 0
  }
}

export const agentRunSignals = new AgentRunSignals()

export const AGENT_STREAM_BACKSTOP_MS = 60_000

export const AGENT_POLL_MS = 2_000

export function agentWaitMs(liveness: StreamLiveness): number {
  return liveness === 'live' ? AGENT_STREAM_BACKSTOP_MS : AGENT_POLL_MS
}

export async function waitForAgentRunSignal(
  signals: AgentRunSignals,
  runId: string,
  timer: Promise<void>,
): Promise<void> {
  const signalled = signals.wait(runId)
  try {
    await Promise.race([timer, signalled.promise])
  } finally {
    signalled.cancel()
  }
}
