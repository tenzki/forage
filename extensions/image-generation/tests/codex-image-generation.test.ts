import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const processMock = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({
  default: { spawn: processMock.spawn },
  spawn: processMock.spawn,
}))

import {
  generateCodexSubscriptionImage,
  validCodexPng,
} from '../src/codex-image-generation'

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]).toString('base64')

function fakeCodexProcess() {
  const process = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter
    stderr: EventEmitter
    stdin: { write: (data: string) => boolean }
    kill: ReturnType<typeof vi.fn>
    exitCode: number | null
  }
  process.stdout = new EventEmitter()
  process.stderr = new EventEmitter()
  process.exitCode = null
  process.kill = vi.fn(() => {
    process.exitCode = 0
    queueMicrotask(() => process.emit('close', 0))
    return true
  })
  process.stdin = {
    write(data) {
      const request = JSON.parse(data) as { id?: number; method: string }
      if (typeof request.id !== 'number') return true
      const result = request.method === 'thread/start' ? { thread: { id: 'thread-1' } } : {}
      queueMicrotask(() => {
        process.stdout.emit('data', `${JSON.stringify({ id: request.id, result })}\n`)
        if (request.method === 'turn/start') {
          process.stdout.emit('data', `${JSON.stringify({
            method: 'item/completed',
            params: {
              item: { type: 'imageGeneration', status: 'completed', result: PNG, revisedPrompt: 'An otter' },
            },
          })}\n`)
        }
      })
      return true
    },
  }
  return process
}

afterEach(() => {
  processMock.spawn.mockReset()
})

describe('Codex subscription image generation', () => {
  it('accepts only bounded PNG payloads', () => {
    expect(validCodexPng(PNG)).toBe(true)
    expect(validCodexPng(Buffer.from('not an image').toString('base64'))).toBe(false)
    expect(validCodexPng('%%%')).toBe(false)
  })

  it('does not spawn when already cancelled', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(generateCodexSubscriptionImage({
      prompt: 'Otter', size: '1024x1024', quality: 'low', accessToken: 'token', accountId: 'account', signal: controller.signal,
    })).rejects.toThrow()
    expect(processMock.spawn).not.toHaveBeenCalled()
  })

  it('stops Codex promptly when cancelled during initialization', async () => {
    const child = fakeCodexProcess()
    const controller = new AbortController()
    child.stdin.write = () => { controller.abort(); return true }
    processMock.spawn.mockReturnValue(child)
    await expect(generateCodexSubscriptionImage({
      prompt: 'Otter', size: '1024x1024', quality: 'low', accessToken: 'token', accountId: 'account', signal: controller.signal,
    })).rejects.toThrow()
    expect(child.kill).toHaveBeenCalled()
  })

  it('passes external OAuth tokens over RPC, never process args or environment', async () => {
    processMock.spawn.mockReturnValue(fakeCodexProcess())

    await expect(generateCodexSubscriptionImage({
      prompt: 'An otter',
      size: '1024x1024',
      quality: 'low',
      accessToken: 'secret-access-token',
      accountId: 'secret-account-id',
    })).resolves.toEqual({ base64: PNG, revisedPrompt: 'An otter' })

    const [, args, options] = processMock.spawn.mock.calls[0]
    expect(JSON.stringify(args)).not.toContain('secret-access-token')
    expect(JSON.stringify(options.env)).not.toContain('secret-access-token')
    expect(JSON.stringify(options.env)).not.toContain('secret-account-id')
    expect(options.env.AI_CHAT_API_KEY).toBeUndefined()
  })
})
