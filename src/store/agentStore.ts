import { create } from 'zustand'
import { listen } from '@tauri-apps/api/event'
import { extractText } from '../types/tree'
import type { JsonValue } from '../lib/bindings'
import {
  getAncestorsIpc,
  getNodeIpc,
  agentCommandIpc,
  createNodeIpc,
  updateNodeIpc,
  deleteNodeIpc,
} from './ipc'
import { useTreeStore } from './treeStore'

// ─── Constants ────────────────────────────────────────────────────────────────

/** Token budget: conservative estimate well under 128k/200k model limits */
export const MAX_CONTEXT_TOKENS = 100_000

/** Always keep the most recent N messages in full regardless of context length */
export const RECENT_MESSAGES_TO_KEEP = 4

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ContextMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface ActiveGeneration {
  nodeId: string       // triggering node
  ghostNodeId: string  // child node receiving streamed content (or same as nodeId for replace mode)
  skillId: string
  args: string
  tokens: string       // accumulated streamed text
  status: 'streaming' | 'complete' | 'error' | 'cancelled'
  outputMode: 'child' | 'replace'
  requestId: string   // sidecar prompt request id
}

interface AgentState {
  activeGenerations: Map<string, ActiveGeneration>
}

interface AgentActions {
  /** Sets up listener for agent-event from Tauri. Call once on mount. */
  initAgentListener(): Promise<() => void>

  /** Core action: triggered by slash command selection */
  invokeSkill(nodeId: string, skillId: string, args: string): Promise<void>

  /** Context building (with summarization if tokens exceed threshold) */
  buildContextMessages(nodeId: string): Promise<ContextMessage[]>

  /** Streaming: accumulate token delta into ghost node */
  appendToken(nodeId: string, delta: string): void

  /** Mark generation as complete and persist */
  finalizeGeneration(nodeId: string): Promise<void>

  /** Cancel an active generation */
  cancelGeneration(nodeId: string): Promise<void>
}

export type AgentStore = AgentState & AgentActions

// ─── Token Estimation ─────────────────────────────────────────────────────────

/**
 * Estimate token count using chars/4 heuristic.
 * Conservative estimate — no tokenizer dependency needed.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

// ─── Content Helpers ──────────────────────────────────────────────────────────

/**
 * Convert plain text to a TipTap-compatible ProseMirror doc JSON.
 */
function textToTipTapContent(text: string): JsonValue {
  return {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: text ? [{ type: 'text', text }] : [],
      },
    ],
  }
}

// ─── Context Building ─────────────────────────────────────────────────────────

/**
 * Build context messages from a node's ancestor chain.
 * nodes with node_type === 'agent_response' become assistant messages;
 * all others become user messages.
 * The triggering node itself is included as the final user message.
 */
export async function buildContextMessages(nodeId: string): Promise<ContextMessage[]> {
  // 1. Get the ordered ancestor chain (root to parent)
  const ancestors = await getAncestorsIpc(nodeId)

  // 2. Fetch full node data for each ancestor
  const ancestorNodes = await Promise.all(ancestors.map((a) => getNodeIpc(a.id)))

  // 3. Fetch the triggering node itself
  const triggeringNode = await getNodeIpc(nodeId)

  // 4. Map to messages: agent_response → assistant, others → user
  const ancestorMessages: ContextMessage[] = ancestorNodes.map((node) => ({
    role: node.node_type === 'agent_response' ? 'assistant' : 'user',
    content: extractText(node.content),
  }))

  const triggeringMessage: ContextMessage = {
    role: 'user',
    content: extractText(triggeringNode.content),
  }

  const allMessages = [...ancestorMessages, triggeringMessage]

  // 5. Apply summarization if needed
  return summarizeOlderMessages(allMessages)
}

/**
 * Apply context summarization when total tokens exceed MAX_CONTEXT_TOKENS.
 * Recent messages (last RECENT_MESSAGES_TO_KEEP) are always kept in full.
 * Older messages are summarized via the sidecar if over budget.
 */
export async function summarizeOlderMessages(messages: ContextMessage[]): Promise<ContextMessage[]> {
  // Count total tokens
  const totalTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0)

  // Under budget — return as-is
  if (totalTokens <= MAX_CONTEXT_TOKENS) {
    return messages
  }

  // Over budget — split into older and recent groups
  const recentCount = Math.min(RECENT_MESSAGES_TO_KEEP, messages.length)
  const olderMessages = messages.slice(0, messages.length - recentCount)
  const recentMessages = messages.slice(messages.length - recentCount)

  if (olderMessages.length === 0) {
    // Can't summarize — all messages are "recent"
    return messages
  }

  // Request summarization from sidecar
  const requestId = `summary-${Date.now()}-${Math.random().toString(36).slice(2)}`

  try {
    const summaryContent = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubscribeRef.cleanup?.()
        reject(new Error('Summarization timed out after 30s'))
      }, 30_000)

      const unsubscribeRef: { cleanup?: () => void } = {}

      listen<string>('agent-event', (event) => {
        try {
          const data = typeof event.payload === 'string'
            ? JSON.parse(event.payload)
            : event.payload
          if (data.type === 'summary' && data.id === requestId) {
            clearTimeout(timeout)
            unsubscribeRef.cleanup?.()
            resolve(data.content as string)
          }
        } catch {
          // ignore parse errors for unrelated events
        }
      }).then((unlisten) => {
        unsubscribeRef.cleanup = unlisten
      }).catch(reject)

      // Send summarize command to sidecar
      agentCommandIpc({
        type: 'summarize',
        id: requestId,
        messages: olderMessages,
      }).catch(reject)
    })

    const summaryMessage: ContextMessage = {
      role: 'user',
      content: `[Context summary]: ${summaryContent}`,
    }

    return [summaryMessage, ...recentMessages]
  } catch (e) {
    console.warn('Context summarization failed, using truncated context:', e)
    // Fallback: just use recent messages if summarization fails
    return recentMessages
  }
}

// ─── Zustand Store ────────────────────────────────────────────────────────────

export const useAgentStore = create<AgentStore>((set, get) => ({
  activeGenerations: new Map(),

  buildContextMessages,

  initAgentListener: async () => {
    const unlisten = await listen<string>('agent-event', (event) => {
      try {
        const data = typeof event.payload === 'string'
          ? JSON.parse(event.payload)
          : event.payload

        const { id } = data as { id?: string }
        if (!id) return

        // Find generation by requestId
        const { activeGenerations } = get()
        let matchedNodeId: string | null = null
        for (const [nodeId, gen] of activeGenerations.entries()) {
          if (gen.requestId === id) {
            matchedNodeId = nodeId
            break
          }
        }

        if (!matchedNodeId) return

        if (data.type === 'message_update') {
          const delta = data.assistantMessageEvent?.delta as string | undefined
          if (delta) {
            get().appendToken(matchedNodeId, delta)
          }
        } else if (data.type === 'turn_end') {
          get().finalizeGeneration(matchedNodeId).catch((e) =>
            console.error('[agent] finalizeGeneration failed:', e)
          )
        } else if (data.type === 'agent_end') {
          // Clear generation from map
          set((state) => {
            const newMap = new Map(state.activeGenerations)
            newMap.delete(matchedNodeId!)
            return { activeGenerations: newMap }
          })
        } else if (data.type === 'error') {
          const errorMsg = data.message as string
          console.error('[agent] Error from sidecar:', errorMsg)
          // Set error status and show in ghost node
          set((state) => {
            const newMap = new Map(state.activeGenerations)
            const gen = newMap.get(matchedNodeId!)
            if (gen) {
              newMap.set(matchedNodeId!, { ...gen, status: 'error' })
            }
            return { activeGenerations: newMap }
          })
          const gen = get().activeGenerations.get(matchedNodeId!)
          if (gen) {
            const errorContent = textToTipTapContent(`[Error: ${errorMsg}]`)
            useTreeStore.getState().updateNodeLocally(gen.ghostNodeId, { content: errorContent })
          }
        }
      } catch (e) {
        // ignore parse errors for unrelated events
        console.warn('[agent] Failed to parse agent-event:', e)
      }
    })

    return unlisten
  },

  invokeSkill: async (nodeId: string, skillId: string, args: string) => {
    const { activeGenerations } = get()

    // Prevent duplicate invocations for the same node
    if (activeGenerations.has(nodeId)) {
      console.warn(`[agent] Skill already active for node ${nodeId}`)
      return
    }

    // Determine output mode (brainstorm splits into multiple children; replace mode for future skills)
    const outputMode: 'child' | 'replace' = 'child'

    try {
      // 1. Build context messages (with summarization if needed)
      const contextMessages = await buildContextMessages(nodeId)

      // 2. Store command in node metadata (command text not visible in content)
      await updateNodeIpc(nodeId, null, null, null, JSON.stringify({ slashCommand: { skillId, args } }))
        .catch((e) => console.warn('[agent] Failed to store command metadata:', e))

      // 3. Create a ghost child node for the streamed response
      const emptyContent = { type: 'doc', content: [{ type: 'paragraph' }] }
      const ghostNode = await createNodeIpc(
        nodeId,
        '0.5', // will be positioned properly by tree
        'agent_response',
        emptyContent,
        JSON.stringify({ partial: true }),
        ''
      )

      // 4. Track active generation
      const requestId = `prompt-${nodeId}-${Date.now()}`
      const generation: ActiveGeneration = {
        nodeId,
        ghostNodeId: ghostNode.id,
        skillId,
        args,
        tokens: '',
        status: 'streaming',
        outputMode,
        requestId,
      }

      set((state) => {
        const newMap = new Map(state.activeGenerations)
        newMap.set(nodeId, generation)
        return { activeGenerations: newMap }
      })

      // 5. Send prompt to sidecar
      await agentCommandIpc({
        type: 'prompt',
        id: requestId,
        text: args,
        messages: contextMessages,
        skill: skillId,
      })
    } catch (e) {
      console.error('[agent] invokeSkill failed:', e)
      // Remove failed generation from tracking
      set((state) => {
        const newMap = new Map(state.activeGenerations)
        newMap.delete(nodeId)
        return { activeGenerations: newMap }
      })
    }
  },

  appendToken: (nodeId: string, delta: string) => {
    const { activeGenerations } = get()
    const generation = activeGenerations.get(nodeId)
    if (!generation) return

    const newTokens = generation.tokens + delta
    const updated: ActiveGeneration = {
      ...generation,
      tokens: newTokens,
    }

    set((state) => {
      const newMap = new Map(state.activeGenerations)
      newMap.set(nodeId, updated)
      return { activeGenerations: newMap }
    })

    // Convert accumulated text to TipTap JSON and update the ghost node locally
    const tiptapContent = textToTipTapContent(newTokens)
    useTreeStore.getState().updateNodeLocally(generation.ghostNodeId, { content: tiptapContent })
  },

  finalizeGeneration: async (nodeId: string) => {
    const { activeGenerations } = get()
    const generation = activeGenerations.get(nodeId)
    if (!generation) return

    const finalText = generation.tokens

    // Mark as complete
    set((state) => {
      const newMap = new Map(state.activeGenerations)
      newMap.set(nodeId, { ...generation, status: 'complete' })
      return { activeGenerations: newMap }
    })

    if (generation.skillId === 'brainstorm') {
      // Parse bullet points and create separate child nodes
      const lines = finalText
        .split('\n')
        .map(l => l.replace(/^[\s-*•]+/, '').trim())
        .filter(l => l.length > 0)

      if (lines.length === 0) {
        // No ideas parsed — delete ghost node
        await deleteNodeIpc(generation.ghostNodeId).catch((e) =>
          console.warn('[agent] Failed to delete empty ghost node:', e)
        )
        useTreeStore.getState().updateNodeLocally(generation.ghostNodeId, { content: null as any })
        await useTreeStore.getState().loadTree()
        return
      }

      // Delete the ghost node (it was just a placeholder during streaming)
      await deleteNodeIpc(generation.ghostNodeId).catch((e) =>
        console.warn('[agent] Failed to delete brainstorm ghost node:', e)
      )

      // Create separate child nodes for each idea
      for (let i = 0; i < lines.length; i++) {
        const ideaContent = textToTipTapContent(lines[i])
        const position = String(i + 1) // simple sequential positions
        try {
          await createNodeIpc(
            nodeId,
            position,
            'agent_response',
            ideaContent,
            null,
            lines[i]
          )
        } catch (e) {
          console.warn('[agent] Failed to create brainstorm idea node:', e)
        }
      }

      // Reload tree to show all new child nodes
      await useTreeStore.getState().loadTree()
    } else {
      // children mode (ask, research): persist ghost node content to DB
      const finalContent = textToTipTapContent(finalText)

      try {
        // Persist content to DB
        await updateNodeIpc(
          generation.ghostNodeId,
          finalContent,
          null,
          null,
          JSON.stringify({ partial: false }), // remove partial flag
          finalText
        )
        // Update local tree content visually (metadata not tracked in TreeNode)
        useTreeStore.getState().updateNodeLocally(generation.ghostNodeId, {
          content: finalContent,
        })
      } catch (e) {
        console.error('[agent] Failed to persist ghost node content:', e)
      }
    }
  },

  cancelGeneration: async (nodeId: string) => {
    const { activeGenerations } = get()
    const generation = activeGenerations.get(nodeId)
    if (!generation) return

    // Mark as cancelled immediately
    set((state) => {
      const newMap = new Map(state.activeGenerations)
      newMap.set(nodeId, { ...generation, status: 'cancelled' })
      return { activeGenerations: newMap }
    })

    try {
      // Send abort command to sidecar
      await agentCommandIpc({ type: 'abort', nodeId })
    } catch (e) {
      console.warn('[agent] Failed to send abort command:', e)
    }

    // Handle ghost node based on whether any content was streamed
    const hasContent = generation.tokens.trim().length > 0

    if (hasContent) {
      // Keep partial content with partial metadata
      const partialContent = textToTipTapContent(generation.tokens)
      try {
        await updateNodeIpc(
          generation.ghostNodeId,
          partialContent,
          null,
          null,
          JSON.stringify({ partial: true, cancelled: true }),
          generation.tokens
        )
      } catch (e) {
        console.warn('[agent] Failed to persist partial content on cancel:', e)
      }
    } else {
      // No content streamed yet — delete empty ghost node
      try {
        await deleteNodeIpc(generation.ghostNodeId)
        useTreeStore.getState().updateNodeLocally(generation.ghostNodeId, { content: null as any })
        await useTreeStore.getState().loadTree()
      } catch (e) {
        console.warn('[agent] Failed to delete empty ghost node on cancel:', e)
      }
    }

    // Remove from active generations
    set((state) => {
      const newMap = new Map(state.activeGenerations)
      newMap.delete(nodeId)
      return { activeGenerations: newMap }
    })
  },
}))
