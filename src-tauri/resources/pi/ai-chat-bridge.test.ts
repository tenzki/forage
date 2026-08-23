import { afterEach, describe, expect, it, vi } from 'vitest'

const codexMocks = vi.hoisted(() => ({
  generateCodexSubscriptionImage: vi.fn(),
}))
vi.mock('./codex-image-generation', () => codexMocks)

import aiChatBridge from './ai-chat-bridge'

interface RegisteredTool {
  execute: (id: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<Record<string, unknown>>
}

function bridgeHarness() {
  const tools = new Map<string, RegisteredTool>()
  const commands = new Map<string, { handler: (args: string, context: { ui: { notify: () => void } }) => Promise<void> }>()
  let activeTools: string[] = []
  const pi = {
    registerProvider: vi.fn(),
    registerTool: (tool: RegisteredTool & { name: string }) => tools.set(tool.name, tool),
    registerCommand: (name: string, command: { handler: (args: string, context: { ui: { notify: () => void } }) => Promise<void> }) => commands.set(name, command),
    setActiveTools: (ids: string[]) => { activeTools = ids },
    sendUserMessage: vi.fn(),
    on: vi.fn(),
  }
  aiChatBridge(pi as never)
  return { tools, commands, activeTools: () => activeTools }
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  codexMocks.generateCodexSubscriptionImage.mockReset()
})

describe('Pi image bridge', () => {
  it('requires complete ChatGPT credentials for subscription image generation', async () => {
    vi.stubEnv('AI_CHAT_PROVIDER', 'openai-codex')
    vi.stubEnv('AI_CHAT_API_KEY', 'subscription-token')
    vi.stubEnv('AI_CHAT_ACCOUNT_ID', '')
    const { tools } = bridgeHarness()

    await expect(tools.get('generate_image')!.execute('1', { prompt: 'An otter' }))
      .rejects.toThrow(/subscription credentials are missing/)
  })

  it('uses the isolated Codex image client with subscription OAuth', async () => {
    vi.stubEnv('AI_CHAT_PROVIDER', 'openai-codex')
    vi.stubEnv('AI_CHAT_API_KEY', 'subscription-token')
    vi.stubEnv('AI_CHAT_ACCOUNT_ID', 'account-123')
    const base64 = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]).toString('base64')
    codexMocks.generateCodexSubscriptionImage.mockResolvedValue({ base64, revisedPrompt: null })
    const { tools } = bridgeHarness()

    const generated = await tools.get('generate_image')!.execute('1', { prompt: 'An otter' })
    const imageId = (generated.details as { imageId: string }).imageId
    const emitted = await tools.get('emit_outline')!.execute('2', {
      nodes: [{ imageId, imageAlt: 'An illustrated otter' }],
    })
    const nodes = (emitted.details as { nodes: Array<{ type: string; image: { src: string; alt: string } }> }).nodes

    expect(nodes[0].type).toBe('image')
    expect(codexMocks.generateCodexSubscriptionImage).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'An otter', accessToken: 'subscription-token', accountId: 'account-123',
    }))
    expect(JSON.stringify(generated)).not.toContain(base64)
    expect(nodes[0].image).toEqual({ src: `data:image/png;base64,${base64}`, alt: 'An illustrated otter' })
  })

  it('uses the billed Images API in API-key mode and resolves only opaque ids', async () => {
    vi.stubEnv('AI_CHAT_PROVIDER', 'openai')
    vi.stubEnv('AI_CHAT_API_KEY', 'test-platform-key')
    const base64 = Buffer.from('RIFF\u0004\u0000\u0000\u0000WEBP', 'binary').toString('base64')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ data: [{ b64_json: base64 }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    const { tools } = bridgeHarness()

    const generated = await tools.get('generate_image')!.execute('1', { prompt: 'An otter' })
    const imageId = (generated.details as { imageId: string }).imageId
    const emitted = await tools.get('emit_outline')!.execute('2', {
      nodes: [{ imageId, imageAlt: 'An illustrated otter' }],
    })
    const nodes = (emitted.details as { nodes: Array<{ type: string; image: { src: string; alt: string } }> }).nodes

    expect(nodes[0].type).toBe('image')
    expect(fetchMock).toHaveBeenCalledWith('https://api.openai.com/v1/images/generations', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer test-platform-key' }),
    }))
    expect(JSON.stringify(generated)).not.toContain(base64)
    expect(nodes[0].image).toEqual({ src: `data:image/webp;base64,${base64}`, alt: 'An illustrated otter' })
  })

  it('activates image generation only when the invocation allowlist enables it', async () => {
    const { commands, activeTools } = bridgeHarness()
    const payload = Buffer.from(JSON.stringify({
      instructions: 'Help.', prompt: 'Draw.', context: [],
      enabledToolIds: ['generate_image', 'unknown'], customTools: [],
    })).toString('base64url')

    await commands.get('ai-chat-run')!.handler(payload, { ui: { notify: vi.fn() } })

    expect(activeTools()).toEqual(['emit_outline', 'search_outline', 'generate_image'])
  })

  describe('search_outline tool', () => {
    it('returns no-match when snapshot is empty', async () => {
      const { tools } = bridgeHarness()
      const result = await tools.get('search_outline')!.execute('1', { query: 'anything' })
      expect(result.content[0].text).toContain('no searchable nodes')
    })

    it('searches the outline snapshot via the ai-chat-run command', async () => {
      const { commands, tools } = bridgeHarness()
      const snapshot = JSON.stringify([
        { nodeId: 'a', text: 'Otter research', depth: 0, ancestorTexts: [] },
        { nodeId: 'b', text: 'Sea otters', depth: 1, ancestorTexts: ['Otter research'] },
        { nodeId: 'c', text: 'River otters', depth: 1, ancestorTexts: ['Otter research'] },
      ])
      const payload = Buffer.from(JSON.stringify({
        instructions: 'Help.', prompt: 'Search.', context: [],
        enabledToolIds: [], customTools: [], outlineSnapshot: snapshot,
      })).toString('base64url')

      await commands.get('ai-chat-run')!.handler(payload, { ui: { notify: vi.fn() } })

      const result = await tools.get('search_outline')!.execute('1', { query: 'otter', maxResults: 5 })
      expect(result.content[0].text).toContain('Found 3 matching')
      expect(result.content[0].text).toContain('Otter research')
      expect(result.content[0].text).toContain('Sea otters')
    })

    it('respects maxResults', async () => {
      const { commands, tools } = bridgeHarness()
      const snapshot = JSON.stringify([
        { nodeId: 'a', text: 'Alpha', depth: 0, ancestorTexts: [] },
        { nodeId: 'b', text: 'Beta', depth: 0, ancestorTexts: [] },
        { nodeId: 'c', text: 'Gamma', depth: 0, ancestorTexts: [] },
        { nodeId: 'd', text: 'Delta', depth: 0, ancestorTexts: [] },
      ])
      const payload = Buffer.from(JSON.stringify({
        instructions: 'Help.', prompt: 'Search.', context: [],
        enabledToolIds: [], customTools: [], outlineSnapshot: snapshot,
      })).toString('base64url')

      await commands.get('ai-chat-run')!.handler(payload, { ui: { notify: vi.fn() } })

      const result = await tools.get('search_outline')!.execute('1', { query: 'a', maxResults: 2 })
      expect(result.content[0].text).toContain('Found 2 matching')
    })

    it('gracefully handles malformed snapshot', async () => {
      const { commands, tools } = bridgeHarness()
      const payload = Buffer.from(JSON.stringify({
        instructions: 'Help.', prompt: 'Search.', context: [],
        enabledToolIds: [], customTools: [], outlineSnapshot: 'not-json',
      })).toString('base64url')

      await commands.get('ai-chat-run')!.handler(payload, { ui: { notify: vi.fn() } })

      const result = await tools.get('search_outline')!.execute('1', { query: 'anything' })
      expect(result.content[0].text).toContain('no searchable nodes')
    })
  })
})
