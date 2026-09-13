// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { WebSocket } from 'ws'
import type { EventEnvelope } from '@forage/domain'
import { outlineStreamServerFrameSchema, type OutlineStreamServerFrame } from '@forage/protocol'
import {
  InMemoryOutlineChangeNotifier,
  MAX_STREAM_EVENTS,
  registerOutlineStream,
} from './outlineStream'
import { RepositoryError, type ServerRepository } from './repository'

const OUTLINE = 'outline_test'

function event(revision: number): EventEnvelope {
  return {
    id: `event-${revision}`, outlineId: OUTLINE, actorId: 'owner-1', deviceId: 'device-1',
    type: 'note.created', eventVersion: 1, documentVersion: 1, schemaEpoch: 1,
    baseRevision: revision - 1, revision, origin: 'desktop',
    occurredAt: '2026-09-13T12:00:00.000Z',
    payload: { noteId: `note-${revision}`, parentId: 'inbox', text: `note ${revision}` },
  } as EventEnvelope
}

const servers: FastifyInstance[] = []
const sockets: WebSocket[] = []

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.close()
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

async function streamServer(options: { authorized?: boolean } = {}) {
  let head = 0
  const repository = {
    currentRevision: async () => head,
    eventsAfter: async (_outlineId: string, after: number, limit: number) => {
      const events: EventEnvelope[] = []
      for (let revision = after + 1; revision <= head && events.length < limit; revision += 1) {
        events.push(event(revision))
      }
      return events
    },
  } as unknown as ServerRepository
  const notifier = new InMemoryOutlineChangeNotifier()
  const app = Fastify({ logger: false })
  registerOutlineStream(app, {
    repository,
    notifier,
    authorize: async () => {
      if (options.authorized === false) {
        throw new RepositoryError('authentication_required', 'Authentication is required.')
      }
      return OUTLINE
    },
  })
  servers.push(app)
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  if (typeof address === 'string' || !address) throw new Error('The test server has no port.')
  return {
    notifier,
    url: `ws://127.0.0.1:${address.port}/api/v1/outlines/${OUTLINE}/stream`,
    advanceTo: (revision: number) => { head = revision },
    publishOutline: (revision: number) => notifier.publish({ kind: 'outline', outlineId: OUTLINE, revision }),
  }
}

function connect(url: string): { socket: WebSocket; next: () => Promise<OutlineStreamServerFrame> } {
  const socket = new WebSocket(url)
  sockets.push(socket)
  const buffered: OutlineStreamServerFrame[] = []
  const waiting: Array<(frame: OutlineStreamServerFrame) => void> = []
  socket.on('message', (raw) => {
    const frame = outlineStreamServerFrameSchema.parse(JSON.parse(String(raw)))
    const resolve = waiting.shift()
    if (resolve) resolve(frame)
    else buffered.push(frame)
  })
  return {
    socket,
    next: () => new Promise<OutlineStreamServerFrame>((resolve, reject) => {
      const buffer = buffered.shift()
      if (buffer) { resolve(buffer); return }
      const timer = setTimeout(() => reject(new Error('No stream frame arrived.')), 2_000)
      waiting.push((frame) => { clearTimeout(timer); resolve(frame) })
    }),
  }
}

async function hello(url: string, afterRevision: number) {
  const client = connect(url)
  await new Promise((resolve, reject) => {
    client.socket.on('open', resolve)
    client.socket.on('error', reject)
  })
  client.socket.send(JSON.stringify({ type: 'hello', afterRevision, deviceId: 'device-1' }))
  return client
}

describe('outline stream', () => {
  it('refuses the upgrade when the request is not authorized', async () => {
    const { url } = await streamServer({ authorized: false })
    const socket = new WebSocket(url)
    sockets.push(socket)
    const failure = await new Promise<Error>((resolve) => socket.on('error', resolve))
    expect(failure.message).toContain('401')
  })

  it('acknowledges the client cursor with the current revision', async () => {
    const server = await streamServer()
    server.advanceTo(4)
    const client = await hello(server.url, 4)
    expect(await client.next()).toEqual({ type: 'ready', currentRevision: 4 })
  })

  it('pushes a contiguous batch that follows the client cursor', async () => {
    const server = await streamServer()
    server.advanceTo(4)
    const client = await hello(server.url, 4)
    expect(await client.next()).toEqual({ type: 'ready', currentRevision: 4 })

    server.advanceTo(6)
    server.publishOutline(6)

    const frame = await client.next()
    expect(frame.type).toBe('events')
    if (frame.type !== 'events') throw new Error('unreachable')
    expect(frame.fromRevision).toBe(4)
    expect(frame.toRevision).toBe(6)
    expect(frame.events.map((item) => item.revision)).toEqual([5, 6])
  })

  it('sends everything the client missed while it was away', async () => {
    const server = await streamServer()
    server.advanceTo(9)
    const client = await hello(server.url, 4)
    expect(await client.next()).toEqual({ type: 'ready', currentRevision: 9 })

    const frame = await client.next()
    expect(frame.type).toBe('events')
    if (frame.type !== 'events') throw new Error('unreachable')
    expect(frame.fromRevision).toBe(4)
    expect(frame.toRevision).toBe(9)
  })

  it('asks a far behind client to resynchronize rather than streaming bulk history', async () => {
    const server = await streamServer()
    server.advanceTo(MAX_STREAM_EVENTS + 50)
    const client = await hello(server.url, 0)
    expect(await client.next()).toEqual({ type: 'ready', currentRevision: MAX_STREAM_EVENTS + 50 })
    expect(await client.next()).toEqual({ type: 'resync', currentRevision: MAX_STREAM_EVENTS + 50 })
  })

  it('relays agent activity without touching the outline cursor', async () => {
    const server = await streamServer()
    server.advanceTo(4)
    const client = await hello(server.url, 4)
    expect(await client.next()).toEqual({ type: 'ready', currentRevision: 4 })

    server.notifier.publish({
      kind: 'agent', outlineId: OUTLINE, runId: 'run-1', activitySeq: 7, status: 'running',
    })

    expect(await client.next()).toEqual({ type: 'agent', runId: 'run-1', activitySeq: 7, status: 'running' })
  })

  it('answers a heartbeat', async () => {
    const server = await streamServer()
    server.advanceTo(1)
    const client = await hello(server.url, 1)
    expect(await client.next()).toEqual({ type: 'ready', currentRevision: 1 })
    client.socket.send(JSON.stringify({ type: 'ping' }))
    expect(await client.next()).toEqual({ type: 'pong' })
  })

  it('ignores a frame it does not understand', async () => {
    const server = await streamServer()
    server.advanceTo(1)
    const client = await hello(server.url, 1)
    expect(await client.next()).toEqual({ type: 'ready', currentRevision: 1 })
    client.socket.send('not json')
    client.socket.send(JSON.stringify({ type: 'unknown' }))
    client.socket.send(JSON.stringify({ type: 'ping' }))
    expect(await client.next()).toEqual({ type: 'pong' })
  })
})
