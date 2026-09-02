import { describe, expect, it, vi } from 'vitest'
import type { RunInput } from '@forage/agent-runtime'
import { createPiLocalRunner } from './piLocalRunner'

function input(): RunInput {
  return {
    version: 1, runId: 'run-1', executionMode: 'local', outlineId: 'outline-1',
    source: { nodeId: 'source-1', text: 'Draw it.' }, target: { parentId: 'source-1' },
    baseRevision: 0, configurationRevision: 1, credentialRef: 'local-openai',
    agent: {
      id: 'agent-1', name: 'Agent', description: 'Agent', systemPrompt: 'Help.', modelId: 'gpt-5',
      toolIds: ['generate_image'],
    },
    skill: {
      id: 'image', label: 'image', description: 'Image', systemPrompt: 'Create an image.',
      agentId: 'agent-1', requiredToolIds: ['generate_image'],
    },
    effectiveToolIds: ['generate_image'], prompt: 'Draw it.', context: ['Inbox'],
    outlineSnapshot: '{"nodes":[]}', customTools: [],
  }
}

describe('Pi local runtime adapter', () => {
  it('converts emitted Pi outlines and generated images into the shared structured result', async () => {
    const generate = vi.fn(async (_auth, _input, options) => {
      options.onActivity?.({ id: 'tool-1', phase: 'start', kind: 'tool', label: 'generate_image' })
      await options.onOutline?.([
        { text: 'Caption', children: [{ text: 'Detail' }] },
        { image: { src: 'data:image/png;base64,bytes', alt: 'A diagram' } },
      ])
      return ''
    })
    const runner = createPiLocalRunner({
      resolveCredential: async () => ({ mode: 'api_key', apiKey: 'secret', oauthCredential: null, modelId: '' }),
      generate,
      assets: { ingestGeneratedImage: async () => ({ assetId: 'a'.repeat(64), alt: 'A diagram' }) },
    })
    const activities: unknown[] = []

    await expect(runner(input(), {
      signal: new AbortController().signal,
      onActivity: async (event) => { activities.push(event) },
    })).resolves.toEqual({
      version: 1,
      nodes: [
        { type: 'text', text: 'Caption', children: [{ type: 'text', text: 'Detail' }] },
        { type: 'image', assetId: 'a'.repeat(64), alt: 'A diagram' },
      ],
      sources: [],
    })
    expect(activities).toEqual([expect.objectContaining({ sequence: 1, kind: 'tool' })])
    expect(generate).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'secret', modelId: 'gpt-5' }),
      expect.objectContaining({ enabledToolIds: ['generate_image'], outlineSnapshot: '{"nodes":[]}' }),
      expect.any(Object),
    )
  })

  it('uses final text only when no structured outline was emitted', async () => {
    const runner = createPiLocalRunner({
      resolveCredential: async () => ({ mode: 'api_key', apiKey: 'secret', oauthCredential: null, modelId: '' }),
      generate: async () => 'First line\n\nSecond line',
      assets: { ingestGeneratedImage: async () => { throw new Error('unused') } },
    })
    await expect(runner(input(), {
      signal: new AbortController().signal,
      onActivity: async () => undefined,
    })).resolves.toMatchObject({
      nodes: [{ type: 'text', text: 'First line' }, { type: 'text', text: 'Second line' }],
    })
  })

  it('does not settle before emitted activity is durably handled', async () => {
    let release!: () => void
    const persisted = new Promise<void>((resolve) => { release = resolve })
    const runner = createPiLocalRunner({
      resolveCredential: async () => ({ mode: 'api_key', apiKey: 'secret', oauthCredential: null, modelId: '' }),
      generate: async (_auth, _input, options) => {
        options.onActivity?.({ id: 'thinking-1', phase: 'start', kind: 'thinking', label: 'Thinking' })
        return 'Done'
      },
      assets: { ingestGeneratedImage: async () => { throw new Error('unused') } },
    })
    let settled = false
    const completion = runner(input(), {
      signal: new AbortController().signal,
      onActivity: async () => persisted,
    }).then(() => { settled = true })
    await new Promise((resolve) => window.setTimeout(resolve, 0))
    expect(settled).toBe(false)
    release()
    await completion
    expect(settled).toBe(true)
  })
})
