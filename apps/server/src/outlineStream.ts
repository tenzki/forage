import type { FastifyInstance, FastifyRequest } from 'fastify'
import websocket from '@fastify/websocket'
import { Client, type Notification } from 'pg'
import { z } from 'zod'
import type { EventEnvelope } from '@forage/domain'
import { outlineStreamClientFrameSchema } from '@forage/protocol'
import { RepositoryError, type ServerRepository } from './repository.js'

/** A committed change worth waking a connected client for. */
export type OutlineChangeSignal =
  | { kind: 'outline'; outlineId: string; revision: number }
  | { kind: 'agent'; outlineId: string; runId: string; activitySeq: number; status: string }

export interface OutlineChangeNotifier {
  subscribe(outlineId: string, listener: (signal: OutlineChangeSignal) => void): () => void
  close(): Promise<void>
}

export const OUTLINE_CHANGED_CHANNEL = 'forage_outline_changed'
export const AGENT_ACTIVITY_CHANNEL = 'forage_agent_activity'

/**
 * The largest run of events pushed over a socket. A client that has fallen
 * further behind is told to resynchronize over the paged HTTP endpoint instead,
 * which is built for bulk transfer and can be resumed.
 */
export const MAX_STREAM_EVENTS = 200
const MAX_STREAM_BYTES = 512_000

const outlineNotificationSchema = z.object({
  outlineId: z.string().min(1),
  revision: z.number().int().nonnegative(),
})
const agentNotificationSchema = z.object({
  outlineId: z.string().min(1),
  runId: z.string().min(1),
  activitySeq: z.number().int().nonnegative(),
  status: z.string().min(1),
})

class Subscribers {
  private readonly byOutline = new Map<string, Set<(signal: OutlineChangeSignal) => void>>()

  add(outlineId: string, listener: (signal: OutlineChangeSignal) => void): () => void {
    const listeners = this.byOutline.get(outlineId) ?? new Set()
    listeners.add(listener)
    this.byOutline.set(outlineId, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.byOutline.delete(outlineId)
    }
  }

  publish(signal: OutlineChangeSignal): void {
    for (const listener of this.byOutline.get(signal.outlineId) ?? []) listener(signal)
  }
}

/** Single-process notifier, used by the in-memory repository and by tests. */
export class InMemoryOutlineChangeNotifier implements OutlineChangeNotifier {
  private readonly subscribers = new Subscribers()

  subscribe(outlineId: string, listener: (signal: OutlineChangeSignal) => void): () => void {
    return this.subscribers.add(outlineId, listener)
  }

  publish(signal: OutlineChangeSignal): void {
    this.subscribers.publish(signal)
  }

  async close(): Promise<void> {}
}

/**
 * Fans out commits made by any process, including the agent worker, through
 * PostgreSQL LISTEN on a dedicated connection.
 */
export class PostgresOutlineChangeNotifier implements OutlineChangeNotifier {
  private readonly subscribers = new Subscribers()
  private client: Client | null = null
  private closed = false
  private reconnectDelay = 1_000
  private reconnectTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly connectionString: string,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  async start(): Promise<void> {
    if (this.closed) return
    const client = new Client({ connectionString: this.connectionString })
    client.on('error', (error) => {
      this.onError(error)
      this.scheduleReconnect()
    })
    client.on('notification', (notification) => this.dispatch(notification))
    await client.connect()
    await client.query(`LISTEN ${OUTLINE_CHANGED_CHANNEL}`)
    await client.query(`LISTEN ${AGENT_ACTIVITY_CHANNEL}`)
    this.client = client
    this.reconnectDelay = 1_000
  }

  private dispatch(notification: Notification): void {
    if (!notification.payload) return
    let payload: unknown
    try {
      payload = JSON.parse(notification.payload)
    } catch (error) {
      this.onError(error)
      return
    }
    if (notification.channel === OUTLINE_CHANGED_CHANNEL) {
      const parsed = outlineNotificationSchema.safeParse(payload)
      if (parsed.success) this.subscribers.publish({ kind: 'outline', ...parsed.data })
      return
    }
    if (notification.channel === AGENT_ACTIVITY_CHANNEL) {
      const parsed = agentNotificationSchema.safeParse(payload)
      if (parsed.success) this.subscribers.publish({ kind: 'agent', ...parsed.data })
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return
    const previous = this.client
    this.client = null
    void previous?.end().catch(() => undefined)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.start().catch((error) => {
        this.onError(error)
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000)
        this.scheduleReconnect()
      })
    }, this.reconnectDelay)
    this.reconnectTimer.unref?.()
  }

  subscribe(outlineId: string, listener: (signal: OutlineChangeSignal) => void): () => void {
    return this.subscribers.add(outlineId, listener)
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    const client = this.client
    this.client = null
    await client?.end().catch(() => undefined)
  }
}

export interface OutlineStreamOptions {
  repository: ServerRepository
  notifier: OutlineChangeNotifier
  /** Resolves the outline this request may read, or throws to refuse the upgrade. */
  authorize(request: FastifyRequest): Promise<string>
}

interface SocketLike {
  send(data: string): void
  close(code?: number, reason?: string): void
  on(event: 'message' | 'close' | 'error', listener: (payload: never) => void): void
}

const principals = new WeakMap<FastifyRequest, string>()

export function registerOutlineStream(app: FastifyInstance, options: OutlineStreamOptions): void {
  app.register(websocket)
  app.register(async (instance) => {
    instance.get<{ Params: { outlineId: string } }>('/api/v1/outlines/:outlineId/stream', {
      websocket: true,
      // Authorizing before the upgrade lets a rejected client read an HTTP status
      // instead of an opaque socket close, so it can stop retrying on a refusal
      // that will not change.
      preValidation: async (request, reply) => {
        try {
          const outlineId = await options.authorize(request)
          if (outlineId !== request.params.outlineId) {
            throw new RepositoryError('authorization_denied', 'The requested resource is unavailable.')
          }
          principals.set(request, outlineId)
        } catch (error) {
          return reply.code(streamRefusalStatus(error)).send({
            error: {
              code: error instanceof RepositoryError ? error.code : 'authorization_denied',
              message: 'The requested resource is unavailable.',
              retryable: error instanceof RepositoryError && error.code === 'outline_not_synchronized',
            },
          })
        }
      },
    }, (socket, request) => {
      const outlineId = principals.get(request)
      if (!outlineId) {
        socket.close(1008, 'unauthorized')
        return
      }
      attachOutlineStream(
        socket as unknown as SocketLike,
        outlineId,
        options,
        (error) => request.log.error({ error }, 'Outline stream failed'),
      )
    })
  })
}

function streamRefusalStatus(error: unknown): number {
  if (!(error instanceof RepositoryError)) return 403
  if (error.code === 'authentication_required') return 401
  if (error.code === 'outline_not_synchronized' || error.code === 'projection_rebuilding') return 503
  if (error.code === 'upgrade_required') return 426
  return 403
}

function attachOutlineStream(
  socket: SocketLike,
  outlineId: string,
  options: OutlineStreamOptions,
  onError: (error: unknown) => void,
): void {
  let lastSentRevision: number | null = null
  let draining = false
  let pending = false
  let open = true

  const send = (frame: unknown): void => {
    if (!open) return
    try {
      socket.send(JSON.stringify(frame))
    } catch (error) {
      onError(error)
    }
  }

  const drain = async (): Promise<void> => {
    if (draining) {
      pending = true
      return
    }
    draining = true
    try {
      do {
        pending = false
        if (lastSentRevision === null || !open) break
        const currentRevision = await options.repository.currentRevision(outlineId)
        if (currentRevision <= lastSentRevision) break
        const events = await options.repository.eventsAfter(outlineId, lastSentRevision, MAX_STREAM_EVENTS + 1)
        if (events.length > MAX_STREAM_EVENTS || byteLength(events) > MAX_STREAM_BYTES) {
          send({ type: 'resync', currentRevision })
          lastSentRevision = currentRevision
          break
        }
        if (events.length === 0) break
        const toRevision = events.at(-1)?.revision ?? currentRevision
        send({ type: 'events', fromRevision: lastSentRevision, toRevision, events })
        lastSentRevision = toRevision
      } while (pending)
    } catch (error) {
      onError(error)
      send({ type: 'resync', currentRevision: lastSentRevision ?? 0 })
    } finally {
      draining = false
    }
  }

  const unsubscribe = options.notifier.subscribe(outlineId, (signal) => {
    if (signal.kind === 'agent') {
      send({ type: 'agent', runId: signal.runId, activitySeq: signal.activitySeq, status: signal.status })
      return
    }
    void drain()
  })

  socket.on('message', (raw: never) => {
    let parsed
    try {
      parsed = outlineStreamClientFrameSchema.safeParse(JSON.parse(String(raw)))
    } catch {
      return
    }
    if (!parsed.success) return
    const frame = parsed.data
    if (frame.type === 'ping') {
      send({ type: 'pong' })
      return
    }
    void (async () => {
      try {
        const currentRevision = await options.repository.currentRevision(outlineId)
        lastSentRevision = Math.min(frame.afterRevision, currentRevision)
        send({ type: 'ready', currentRevision })
        await drain()
      } catch (error) {
        onError(error)
        socket.close(1011, 'unavailable')
      }
    })()
  })

  socket.on('close', () => {
    open = false
    unsubscribe()
  })
  socket.on('error', (error: never) => {
    onError(error)
    open = false
    unsubscribe()
  })
}

function byteLength(events: EventEnvelope[]): number {
  return Buffer.byteLength(JSON.stringify(events))
}
