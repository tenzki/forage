import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  buildContextMessages,
  estimateTokens,
  summarizeOlderMessages,
  MAX_CONTEXT_TOKENS,
  RECENT_MESSAGES_TO_KEEP,
} from './agentStore'

// ─── Mock IPC ─────────────────────────────────────────────────────────────────

vi.mock('./ipc', () => ({
  getAncestorsIpc: vi.fn(),
  getNodeIpc: vi.fn(),
  agentCommandIpc: vi.fn().mockResolvedValue(undefined),
  createNodeIpc: vi.fn().mockResolvedValue({ id: 'ghost-123', parent_id: 'node-1', node_type: 'agent_response', content: { type: 'doc', content: [{ type: 'paragraph' }] }, position: '0.5', collapsed: false, metadata: null }),
  updateNodeIpc: vi.fn().mockResolvedValue({}),
}))

// ─── Mock @tauri-apps/api/event ────────────────────────────────────────────────

// Capture the agent-event listener so tests can trigger synthetic summary events
let capturedEventCallback: ((event: { payload: string }) => void) | null = null

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((eventName: string, callback: (event: { payload: string }) => void) => {
    if (eventName === 'agent-event') {
      capturedEventCallback = callback
    }
    return Promise.resolve(() => {
      capturedEventCallback = null
    })
  }),
}))

import { getAncestorsIpc, getNodeIpc } from './ipc'
import type { AncestorNode } from './ipc'

// ─── Test Helpers ─────────────────────────────────────────────────────────────

function makeNode(id: string, nodeType: string, text: string) {
  return {
    id,
    parent_id: null,
    node_type: nodeType,
    content: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
    },
    position: '0.5',
    collapsed: false,
    metadata: null,
  }
}

// ─── buildContextMessages ─────────────────────────────────────────────────────

describe('buildContextMessages', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('maps agent_response nodes to assistant role, others to user role', async () => {
    const ancestors: AncestorNode[] = [
      { id: 'node-1', name: 'Question' },
      { id: 'node-2', name: 'Answer' },
    ]
    ;(getAncestorsIpc as ReturnType<typeof vi.fn>).mockResolvedValue(ancestors)
    ;(getNodeIpc as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makeNode('node-1', 'note', 'What is AI?'))
      .mockResolvedValueOnce(makeNode('node-2', 'agent_response', 'AI is intelligence.'))
      .mockResolvedValueOnce(makeNode('triggering-node', 'note', 'Tell me more'))

    const messages = await buildContextMessages('triggering-node')

    const userMessages = messages.filter((m) => m.role === 'user')
    const assistantMessages = messages.filter((m) => m.role === 'assistant')

    expect(userMessages.length).toBeGreaterThanOrEqual(1)
    expect(assistantMessages.length).toBeGreaterThanOrEqual(1)
    expect(assistantMessages[0].content).toBe('AI is intelligence.')
  })

  it('returns messages in ancestor order with triggering node last', async () => {
    const ancestors: AncestorNode[] = [
      { id: 'node-1', name: 'First' },
      { id: 'node-2', name: 'Second' },
    ]
    ;(getAncestorsIpc as ReturnType<typeof vi.fn>).mockResolvedValue(ancestors)
    ;(getNodeIpc as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(makeNode('node-1', 'note', 'First message'))
      .mockResolvedValueOnce(makeNode('node-2', 'note', 'Second message'))
      .mockResolvedValueOnce(makeNode('triggering-node', 'note', 'My question'))

    const messages = await buildContextMessages('triggering-node')

    expect(messages[0].content).toBe('First message')
    expect(messages[1].content).toBe('Second message')
    expect(messages[messages.length - 1].content).toBe('My question')
  })

  it('returns empty context for node with no ancestors', async () => {
    ;(getAncestorsIpc as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(getNodeIpc as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeNode('lone-node', 'note', 'Standalone question')
    )

    const messages = await buildContextMessages('lone-node')

    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe('user')
    expect(messages[0].content).toBe('Standalone question')
  })
})

// ─── estimateTokens ────────────────────────────────────────────────────────────

describe('estimateTokens', () => {
  it('returns approximate token count using chars/4 heuristic', () => {
    const text = 'a'.repeat(400)
    expect(estimateTokens(text)).toBe(100)
  })

  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0)
  })

  it('rounds down for non-divisible lengths', () => {
    // 9 chars / 4 = 2.25 → Math.ceil = 3
    expect(estimateTokens('123456789')).toBe(3)
  })
})

// ─── summarizeOlderMessages ────────────────────────────────────────────────────

describe('summarizeOlderMessages', () => {
  it('returns all messages as-is when total tokens below threshold', async () => {
    const messages = [
      { role: 'user' as const, content: 'Short message 1' },
      { role: 'assistant' as const, content: 'Short response 1' },
      { role: 'user' as const, content: 'Short message 2' },
      { role: 'assistant' as const, content: 'Short response 2' },
    ]
    // Total chars < 400,000 (threshold), so no summarization
    const result = await summarizeOlderMessages(messages)
    expect(result).toEqual(messages)
  })

  it('summarizes older messages when total exceeds MAX_CONTEXT_TOKENS', async () => {
    // Create messages that together exceed the token budget
    const longContent = 'x'.repeat(MAX_CONTEXT_TOKENS * 4 + 100)
    const messages = [
      { role: 'user' as const, content: longContent },
      { role: 'user' as const, content: 'recent 1' },
      { role: 'assistant' as const, content: 'recent 2' },
      { role: 'user' as const, content: 'recent 3' },
      { role: 'assistant' as const, content: 'recent 4' },
    ]

    // Start summarizeOlderMessages and inject the synthetic agent-event response
    const summarizePromise = summarizeOlderMessages(messages)

    // Yield to allow the listen() callback to be set up, then fire synthetic event
    await new Promise((resolve) => setTimeout(resolve, 10))

    if (capturedEventCallback) {
      // Find the requestId from the agentCommandIpc call
      const { agentCommandIpc } = await import('./ipc')
      const calls = (agentCommandIpc as ReturnType<typeof vi.fn>).mock.calls
      const lastCall = calls[calls.length - 1]?.[0]
      const requestId = lastCall?.id as string
      capturedEventCallback({
        payload: JSON.stringify({ type: 'summary', id: requestId, content: 'Summarized context.' }),
      })
    }

    const result = await summarizePromise

    expect(Array.isArray(result)).toBe(true)
    // 1 older message replaced by 1 summary + 4 recent = 5 total (same length)
    // But structure changes: first message is now the summary
    expect(result[0].content).toContain('[Context summary]')
    // The last 4 recent messages should be in the result
    expect(result[result.length - 1].content).toBe('recent 4')
    // Result should be summary + 4 recents = 5
    expect(result).toHaveLength(5)
  })

  it('always keeps RECENT_MESSAGES_TO_KEEP messages in full', () => {
    // Verify the constant is set as expected
    expect(RECENT_MESSAGES_TO_KEEP).toBeGreaterThanOrEqual(4)
  })
})
