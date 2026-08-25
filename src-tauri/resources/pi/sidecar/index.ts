#!/usr/bin/env node
/**
 * AI Chat SDK Sidecar — embeds the Pi SDK directly instead of shelling out
 * to `pi --mode rpc`.  Communicates with the Tauri webview via JSONL over
 * stdin/stdout using the same event vocabulary the frontend already expects.
 *
 * Protocol (stdin):
 *   {"type":"run","payload":"<base64url>"}   start a generation
 *   {"type":"abort"}                          abort the current generation
 *
 * Protocol (stdout):
 *   {"type":"message_update","assistantMessageEvent":{"type":"text_delta",...}}
 *   {"type":"tool_execution_start","toolName":"...","args":{...},"toolCallId":"..."}
 *   {"type":"tool_execution_end","toolName":"...","result":{...},"toolCallId":"..."}
 *   {"type":"agent_settled"}
 *   {"type":"process_error","error":"..."}
 */

import {
  createAgentSession,
  DefaultResourceLoader,
  resolveCliModel,
  SessionManager,
  type AgentSession,
} from '@earendil-works/pi-coding-agent'

import {
  createCustomHttpTool,
  createEmitOutlineTool,
  createImageTool,
  createSearchOutlineTool,
  createWebFetchTool,
  createWebSearchTool,
  validateCustomTool,
  type CustomToolConfig,
  type OutlineSnapshotNode,
} from './tools'
import { createAuthenticatedModelRuntime } from './runtime-auth'

// ── constants ───────────────────────────────────────────────────────────────

const MAX_PAYLOAD_BYTES = 512_000
const MAX_CONTEXT_CHARACTERS = 40_000
const STDOUT_CHUNK_SIZE = 32_768

interface RunPayload {
  instructions: string
  prompt: string
  context: string[]
  enabledToolIds: string[]
  customTools: CustomToolConfig[]
  outlineSnapshot?: string
}

// ── helpers ─────────────────────────────────────────────────────────────────

function asStrings(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string').slice(0, limit)
}

function decodePayload(encoded: string): RunPayload {
  if (!encoded || encoded.length > MAX_PAYLOAD_BYTES) throw new Error('Invalid agent invocation payload.')
  const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<RunPayload>
  if (typeof value.instructions !== 'string' || typeof value.prompt !== 'string') {
    throw new Error('Agent invocation is missing instructions or a prompt.')
  }
  if (!Array.isArray(value.context) || value.context.some((item) => typeof item !== 'string')) {
    throw new Error('Agent invocation has invalid outline context.')
  }
  const contextCharacters = value.context.reduce((total, item) => total + item.length, 0)
  if (value.context.length > 500 || contextCharacters > MAX_CONTEXT_CHARACTERS) {
    throw new Error('Agent invocation outline context exceeds the safety limit.')
  }
  const customTools = Array.isArray(value.customTools)
    ? value.customTools.map(validateCustomTool).filter((tool): tool is CustomToolConfig => Boolean(tool)).slice(0, 25)
    : []
  const outlineSnapshot = typeof value.outlineSnapshot === 'string'
    ? value.outlineSnapshot.slice(0, MAX_PAYLOAD_BYTES) : ''
  return {
    instructions: value.instructions.slice(0, 20_000),
    prompt: value.prompt.slice(0, 20_000),
    context: value.context,
    enabledToolIds: asStrings(value.enabledToolIds, 50),
    customTools,
    outlineSnapshot,
  }
}

function taskMessage(payload: RunPayload): string {
  const context = payload.context.length
    ? `Selected outline context (hierarchy preserved by indentation):\n${payload.context.join('\n')}\n\n`
    : ''
  return `${context}Task: ${payload.prompt}`
}

function systemPrompt(instructions: string): string {
  return [
    instructions,
    'Return the final answer by calling emit_outline. Do not edit files or run shell commands.',
  ].join('\n\n')
}

/** Write a JSON object to stdout followed by a newline. */
function emit(value: unknown): void {
  const json = JSON.stringify(value)
  // Write in chunks to avoid buffer limits on the reading side.
  for (let offset = 0; offset < json.length; offset += STDOUT_CHUNK_SIZE) {
    process.stdout.write(json.slice(offset, offset + STDOUT_CHUNK_SIZE))
  }
  process.stdout.write('\n')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const providerId = process.env.AI_CHAT_PROVIDER
  const accessToken = process.env.AI_CHAT_API_KEY?.trim()
  const modelId = process.env.AI_CHAT_MODEL_ID?.trim() || 'gpt-5.5'

  if (!providerId || !accessToken) {
    emit({ type: 'process_error', error: 'Missing AI_CHAT_PROVIDER or AI_CHAT_API_KEY environment variable.' })
    process.exit(1)
  }
  if (providerId !== 'openai' && providerId !== 'openai-codex') {
    emit({ type: 'process_error', error: `Unsupported provider: ${providerId}` })
    process.exit(1)
  }

  // ── set up model runtime with in-memory credentials ──────────────────

  const modelRuntime = providerId === 'openai-codex'
    ? await createAuthenticatedModelRuntime({
      providerId,
      accessToken,
      accountId: process.env.AI_CHAT_ACCOUNT_ID?.trim() || '',
      expires: Number(process.env.AI_CHAT_OAUTH_EXPIRES),
    })
    : await createAuthenticatedModelRuntime({ providerId, accessToken })

  const resolved = resolveCliModel({
    cliModel: `${providerId}/${modelId}`,
    modelRuntime,
  })
  if (resolved.error) {
    emit({ type: 'process_error', error: `Model not available: ${resolved.error}` })
    process.exit(1)
  }
  if (resolved.warning) {
    // Non-fatal; log but continue.
    if (process.env.PI_CODING_AGENT_DIR) {
      process.stderr.write(`[pi-sdk-sidecar] model warning: ${resolved.warning}\n`)
    }
  }

  // ── stdin reader (manual, not readline — avoids Unicode splitting bugs) ─

  let stdinBuffer = ''
  let currentSession: AgentSession | null = null
  let currentAbort: AbortController | null = null

  process.stdin.setEncoding('utf8')
  process.stdin.resume()

  process.stdin.on('data', (chunk: string) => {
    stdinBuffer += chunk
    const lines = stdinBuffer.split('\n')
    stdinBuffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      let command: { type?: string; payload?: string }
      try {
        command = JSON.parse(line) as { type?: string; payload?: string }
      } catch {
        // Ignore malformed input lines.
        continue
      }
      void handleCommand(command)
    }
  })

  async function handleCommand(command: { type?: string; payload?: string }): Promise<void> {
    if (command.type === 'abort') {
      if (currentAbort) {
        currentAbort.abort()
        currentAbort = null
      }
      return
    }

    if (command.type !== 'run' || typeof command.payload !== 'string') return

    // Clean up any previous session.
    if (currentSession) {
      try { await currentSession.abort() } catch { /* ok */ }
      currentSession.dispose()
      currentSession = null
    }

    const abortController = new AbortController()
    currentAbort = abortController

    try {
      const payload = decodePayload(command.payload)
      const outlineSnapshot: OutlineSnapshotNode[] = payload.outlineSnapshot
        ? (() => { try { return JSON.parse(payload.outlineSnapshot) as OutlineSnapshotNode[] } catch { return [] } })()
        : []
      const generatedImages = new Map<string, { src: string; prompt: string }>()

      // Build tool list.
      const toolSet = new Set(payload.enabledToolIds)
      const customToolConfigs = payload.customTools.filter((t) => toolSet.has(t.name))
      const customTools = customToolConfigs.map(createCustomHttpTool)
      const allTools = [
        createWebSearchTool(),
        createWebFetchTool(),
        createImageTool(generatedImages),
        createEmitOutlineTool(generatedImages),
        createSearchOutlineTool(() => outlineSnapshot),
        ...customTools,
      ]
      const allToolNames = allTools.map((t) => t.name)

      // Build system prompt. Skip AGENTS.md — this is an outline agent.
      const loader = new DefaultResourceLoader({
        cwd: process.cwd(),
        agentDir: process.env.PI_CODING_AGENT_DIR || '',
        systemPromptOverride: () => systemPrompt(payload.instructions),
        agentsFilesOverride: () => ({ agentsFiles: [] }),
      })
      await loader.reload()

      // Create session.
      const { session } = await createAgentSession({
        model: resolved.model,
        modelRuntime,
        sessionManager: SessionManager.inMemory(),
        resourceLoader: loader,
        noTools: 'all',
        tools: allToolNames,
        customTools: allTools,
        thinkingLevel: 'low',
      })

      currentSession = session

      // Forward SDK events to stdout.
      const unsubscribe = session.subscribe((event) => {
        switch (event.type) {
          case 'message_update':
            emit(event)
            break
          case 'tool_execution_start':
            emit({
              type: 'tool_execution_start',
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              args: event.args,
            })
            break
          case 'tool_execution_end':
            emit({
              type: 'tool_execution_end',
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              result: event.result,
              isError: event.isError,
            })
            break
          case 'agent_end':
            if (!event.willRetry) {
              emit({ type: 'agent_settled' })
            }
            break
          case 'turn_start':
          case 'turn_end':
          case 'message_start':
          case 'message_end':
          case 'agent_start':
          case 'queue_update':
            // Silently ignore — frontend doesn't need these.
            break
          default:
            break
        }
      })

      // Abort listener.
      const onAbort = () => {
        void session.abort().catch(() => undefined)
      }
      abortController.signal.addEventListener('abort', onAbort, { once: true })

      try {
        // Check if already aborted before we send the prompt.
        if (abortController.signal.aborted) {
          emit({ type: 'agent_settled' })
          return
        }
        await session.prompt(taskMessage(payload))
        // If emit_outline's `terminate: true` didn't fire or session ended
        // without agent_end event, emit settled as a safety net.
        if (!abortController.signal.aborted) {
          // Handled by the agent_end handler above.
        }
      } finally {
        abortController.signal.removeEventListener('abort', onAbort)
        unsubscribe()
        currentSession = null
        try { session.dispose() } catch { /* ok */ }
      }
    } catch (error) {
      if (abortController.signal.aborted) {
        emit({ type: 'agent_settled' })
      } else {
        emit({ type: 'process_error', error: errorMessage(error) })
      }
    } finally {
      currentAbort = null
    }
  }

  // Signal readiness.
  emit({ type: 'ready' })
}

main().catch((error) => {
  emit({ type: 'process_error', error: errorMessage(error) })
  process.exit(1)
})
