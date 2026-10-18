#!/usr/bin/env node
/**
 * Forage Durable Sidecar — runs Pi Durable through the shared runtime.
 * Communicates with the Tauri webview via JSONL over
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
 *   {"type":"agent_settled","outcome":"outline|text","text":"optional final assistant text"}
 *   {"type":"process_error","error":"..."}
 */

import { createAuthenticatedModelRuntime, resolveModel } from '@forage/pi-runtime'
import { modelProviderSchema } from '@forage/agent-runtime'
import { mcpOAuthTokenResponseSchema } from '@forage/agent-runtime'
import { randomUUID } from 'node:crypto'

import { errorMessage, runCommand } from './run'

// ── constants ───────────────────────────────────────────────────────────────

const STDOUT_CHUNK_SIZE = 32_768

// ── helpers ─────────────────────────────────────────────────────────────────

/** Write a JSON object to stdout followed by a newline. */
function emit(value: unknown): void {
  const json = JSON.stringify(value)
  // Write in chunks to avoid buffer limits on the reading side.
  for (let offset = 0; offset < json.length; offset += STDOUT_CHUNK_SIZE) {
    process.stdout.write(json.slice(offset, offset + STDOUT_CHUNK_SIZE))
  }
  process.stdout.write('\n')
}

// ── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const provider = modelProviderSchema.safeParse(process.env.AI_CHAT_PROVIDER)
  const providerId = provider.success ? provider.data : undefined
  const accessToken = process.env.AI_CHAT_API_KEY?.trim()
  const modelId = process.env.AI_CHAT_MODEL_ID?.trim()

  if (!providerId || !accessToken || !modelId) {
    emit({ type: 'process_error', error: 'Missing or unsupported provider, model, or credential.' })
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

  let model: ReturnType<typeof resolveModel>['model']
  try {
    const resolved = resolveModel(modelRuntime, providerId, modelId)
    model = resolved.model
    if (resolved.warning && process.env.PI_CODING_AGENT_DIR) {
      // Non-fatal; log but continue.
      process.stderr.write(`[pi-sidecar] model warning: ${resolved.warning}\n`)
    }
  } catch (error) {
    emit({ type: 'process_error', error: errorMessage(error) })
    process.exit(1)
  }

  // ── stdin reader (manual, not readline — avoids Unicode splitting bugs) ─

  const shutdownController = new AbortController()
  let stdinBuffer = ''
  let currentAbort: AbortController | null = null
  let currentRun: Promise<void> | null = null
  const tokenRequests = new Map<string, (token?: string) => void>()
  const requestToken = (connectionId: string, resource: string, signal: AbortSignal): Promise<string> => new Promise((resolve, reject) => {
    signal.throwIfAborted()
    const requestId = randomUUID()
    const finish = (token?: string) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      tokenRequests.delete(requestId)
      if (token && !signal.aborted) resolve(token)
      else reject(new Error('MCP: Authorization unavailable. Check MCP Settings before retrying explicitly.'))
    }
    const abort = () => finish()
    const timer = setTimeout(() => finish(), 25_000)
    tokenRequests.set(requestId, finish)
    signal.addEventListener('abort', abort, { once: true })
    emit({ type: 'mcp_oauth_token_request', requestId, connectionId, resource })
  })
  const shutdown = () => {
    shutdownController.abort()
    void (currentRun ?? Promise.resolve()).finally(() => process.exit(0))
    setTimeout(() => process.exit(1), 6_000).unref()
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  process.stdin.on('end', shutdown)

  process.stdin.setEncoding('utf8')
  process.stdin.resume()

  process.stdin.on('data', (chunk: string) => {
    stdinBuffer += chunk
    const lines = stdinBuffer.split('\n')
    stdinBuffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      let command: { type?: string; payload?: string; requestId?: string; accessToken?: string }
      try {
        command = JSON.parse(line) as typeof command
      } catch {
        // Ignore malformed input lines.
        continue
      }
      void handleCommand(command)
    }
  })

  async function handleCommand(command: { type?: string; payload?: string; requestId?: string; accessToken?: string }): Promise<void> {
    if (command.type === 'mcp_oauth_token_response') {
      const parsed = mcpOAuthTokenResponseSchema.safeParse(command)
      if (parsed.success) tokenRequests.get(parsed.data.requestId)?.(parsed.data.accessToken)
      return
    }
    if (command.type === 'abort') {
      if (currentAbort) {
        currentAbort.abort()
        currentAbort = null
      }
      return
    }

    if (command.type !== 'run' || typeof command.payload !== 'string') return

    // A new run supersedes any previous one.
    currentAbort?.abort()
    await currentRun?.catch(() => undefined)

    const abortController = new AbortController()
    currentAbort = abortController
    const run = runCommand(command.payload, {
      modelRuntime,
      model,
      accessToken: accessToken!,
      agentDir: process.env.PI_CODING_AGENT_DIR || '',
      signal: abortController.signal,
      suspendSignal: shutdownController.signal,
      emit,
      mcpAuthorization: { accessToken: requestToken, unauthorized: (connectionId) => emit({ type: 'mcp_oauth_required', connectionId }) },
    })
    currentRun = run
    try {
      await run
    } finally {
      if (currentAbort === abortController) currentAbort = null
      if (currentRun === run) currentRun = null
    }
  }

  // Signal readiness.
  emit({ type: 'ready' })
}

main().catch((error) => {
  emit({ type: 'process_error', error: errorMessage(error) })
  process.exit(1)
})
