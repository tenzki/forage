#!/usr/bin/env node
/**
 * Forage SDK Sidecar — embeds the Pi SDK directly instead of shelling out
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
 *   {"type":"agent_settled","text":"optional final assistant text"}
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
  localExtensionSnapshotSchema,
  type LocalExtensionSnapshot,
} from '@forage/agent-runtime'
import {
  ExtensionConfigurationStore,
  acquireManagedRevisionLeases,
  inventoryExtensions,
  loadForageExtension,
  runExtensionEndHooks,
  runExtensionStartHooks,
  sanitizeExtensionText,
  verifyLocalExtensionSnapshot,
  type LoadedForageExtension,
} from '@forage/extension-host'

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
import { FinalResponseTracker } from './final-response'
import { adaptExtensionTools } from './extension-tools'
import { effectiveTools } from './tool-policy'

// ── constants ───────────────────────────────────────────────────────────────

const MAX_PAYLOAD_BYTES = 512_000
const MAX_CONTEXT_CHARACTERS = 40_000
const STDOUT_CHUNK_SIZE = 32_768

interface RunPayload {
  runId: string
  instructions: string
  prompt: string
  context: string[]
  enabledToolIds: string[]
  requiredToolIds: string[]
  customTools: CustomToolConfig[]
  outlineSnapshot?: string
  extensionSnapshot?: LocalExtensionSnapshot
  extensionSecrets: Record<string, Record<string, string>>
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
  const extensionSnapshot = value.extensionSnapshot === undefined
    ? undefined
    : localExtensionSnapshotSchema.parse(value.extensionSnapshot)
  return {
    runId: typeof value.runId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.runId)
      ? value.runId : `run-${Date.now()}`,
    instructions: value.instructions.slice(0, 20_000),
    prompt: value.prompt.slice(0, 20_000),
    context: value.context,
    enabledToolIds: asStrings(value.enabledToolIds, 50),
    requiredToolIds: asStrings(value.requiredToolIds, 50),
    customTools,
    outlineSnapshot,
    extensionSnapshot,
    extensionSecrets: parseExtensionSecrets(value.extensionSecrets),
  }
}

function parseExtensionSecrets(value: unknown): Record<string, Record<string, string>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const output: Record<string, Record<string, string>> = {}
  for (const [installationId, rawSecrets] of Object.entries(value as Record<string, unknown>).slice(0, 128)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(installationId) || !rawSecrets || typeof rawSecrets !== 'object' || Array.isArray(rawSecrets)) continue
    const secrets: Record<string, string> = {}
    for (const [key, secret] of Object.entries(rawSecrets as Record<string, unknown>).slice(0, 64)) {
      if (/^[a-z][a-z0-9_]{0,63}$/.test(key) && typeof secret === 'string' && secret.length <= 20_000) secrets[key] = secret
    }
    output[installationId] = secrets
  }
  return output
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
    let currentSecrets: string[] = [accessToken!]
    let finishExtensions: (() => Promise<void>) | undefined
    let extensionOutcome: 'completed' | 'failed' | 'cancelled' = 'failed'

    try {
      const payload = decodePayload(command.payload)
      currentSecrets = currentSecrets.concat(Object.values(payload.extensionSecrets).flatMap((secrets) => Object.values(secrets)))
      const outlineSnapshot: OutlineSnapshotNode[] = payload.outlineSnapshot
        ? (() => { try { return JSON.parse(payload.outlineSnapshot) as OutlineSnapshotNode[] } catch { return [] } })()
        : []
      const generatedImages = new Map<string, { src: string; prompt: string }>()

      // Build tool list.
      const toolSet = new Set(payload.enabledToolIds)
      const customToolConfigs = payload.customTools.filter((t) => toolSet.has(t.name))
      const customTools = customToolConfigs.map(createCustomHttpTool)
      const builtInTools = [
        createWebSearchTool(), createWebFetchTool(), createImageTool(generatedImages),
        createSearchOutlineTool(() => outlineSnapshot),
      ]
      const admittedExtensions = await loadAdmittedExtensions(payload, customToolConfigs.map((tool) => tool.name), currentSecrets)
      const extensions = admittedExtensions.extensions
      finishExtensions = () => admittedExtensions.release()
      const extensionToolOwners = new Map(extensions.flatMap((extension) => (
        [...extension.tools.keys()].map((toolId) => [toolId, {
          installationId: extension.entry.source.installationId,
          extensionId: extension.entry.manifest!.id,
        }] as const)
      )))
      const snapshottedExtensionTools = new Set(payload.extensionSnapshot?.sources.flatMap((source) => source.toolIds) ?? [])
      const authorizedExtensionTools = new Set([...toolSet].filter((toolId) => snapshottedExtensionTools.has(toolId)))
      const knownSecrets = currentSecrets
      const extensionTools = adaptExtensionTools(extensions, authorizedExtensionTools, {
        signal: abortController.signal,
        secrets: payload.extensionSecrets,
        onProgress: (installationId, extensionId, toolId, progress) => emit({
          type: 'extension_progress', installationId, extensionId, toolName: toolId, progress,
        }),
        onLog: (entry) => emit({
          type: 'extension_log',
          ...entry,
          message: sanitizeExtensionText(entry.message, knownSecrets),
          ...(entry.data === undefined ? {} : { data: sanitizeLogData(entry.data, knownSecrets) }),
        }),
      })
      const allTools = effectiveTools({
        builtIns: builtInTools,
        custom: customTools,
        extensions: extensionTools,
        authorizedToolIds: toolSet,
        requiredToolIds: payload.requiredToolIds,
        outputTool: createEmitOutlineTool(generatedImages),
      })
      const allToolNames = allTools.map((t) => t.name)

      const extensionExecution = {
        signal: abortController.signal,
        onLog: (entry: Parameters<NonNullable<Parameters<LoadedForageExtension['runStart']>[1]['onLog']>>[0]) => emit({
          type: 'extension_log',
          ...entry,
          message: sanitizeExtensionText(entry.message, knownSecrets),
          ...(entry.data === undefined ? {} : { data: sanitizeLogData(entry.data, knownSecrets) }),
        }),
      }
      finishExtensions = async () => {
        try {
          await runExtensionEndHooks(extensions, payload.runId, extensionOutcome, extensionExecution)
        } finally {
          await admittedExtensions.release()
        }
      }
      await runExtensionStartHooks(extensions, payload.runId, extensionExecution)

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
      const finalResponse = new FinalResponseTracker()
      const unsubscribe = session.subscribe((event) => {
        switch (event.type) {
          case 'message_update':
            emit(event)
            break
          case 'tool_execution_start':
            const startOwner = extensionToolOwners.get(event.toolName)
            emit({
              type: 'tool_execution_start',
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              args: event.args,
              ...(startOwner ?? {}),
            })
            break
          case 'tool_execution_end':
            const endOwner = extensionToolOwners.get(event.toolName)
            emit({
              type: 'tool_execution_end',
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              result: event.result,
              isError: event.isError,
              ...(endOwner ?? {}),
            })
            break
          case 'agent_end':
            finalResponse.recordAgentEnd(event.messages, event.willRetry)
            break
          case 'agent_settled':
            emit(finalResponse.settledEvent())
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
          extensionOutcome = 'cancelled'
          emit({ type: 'agent_settled' })
          return
        }
        await session.prompt(taskMessage(payload))
        extensionOutcome = abortController.signal.aborted ? 'cancelled' : 'completed'
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
        extensionOutcome = 'cancelled'
        emit({ type: 'agent_settled' })
      } else {
        emit({ type: 'process_error', error: sanitizeExtensionText(errorMessage(error), currentSecrets) })
      }
    } finally {
      if (finishExtensions) {
        try { await finishExtensions() } catch (error) {
          process.stderr.write(`[forage-extension] run:end failed: ${sanitizeExtensionText(errorMessage(error), currentSecrets)}\n`)
        }
      }
      currentAbort = null
    }
  }

  // Signal readiness.
  emit({ type: 'ready' })
}

async function loadAdmittedExtensions(
  payload: RunPayload,
  customToolIds: string[],
  knownSecrets: readonly string[],
): Promise<{ extensions: LoadedForageExtension[]; release: () => Promise<void> }> {
  if (!payload.extensionSnapshot) return { extensions: [], release: async () => undefined }
  const store = new ExtensionConfigurationStore({ root: process.env.FORAGE_CONFIGURATION_ROOT })
  const configuration = await store.read()
  const catalog = await inventoryExtensions({
    configurationRoot: store.root,
    configuration,
    customHttpToolIds: customToolIds,
  })
  verifyLocalExtensionSnapshot(payload.extensionSnapshot, catalog, configuration)
  const lease = await acquireManagedRevisionLeases(store.root, payload.extensionSnapshot, catalog)
  const loaded: LoadedForageExtension[] = []
  try {
    for (const source of payload.extensionSnapshot.sources) {
      const entry = catalog.entries.find((candidate) => candidate.source.installationId === source.installationId)
      const configured = configuration.sources.find((candidate) => candidate.installationId === source.installationId)
      if (!entry || !configured) throw new Error(`Admitted extension ${source.installationId} is unavailable.`)
      for (const setting of entry.manifest?.contributes.settings ?? []) {
        if (setting.type === 'secret' && setting.required && !payload.extensionSecrets[source.installationId]?.[setting.key]) {
          throw new Error(`Required secret ${setting.key} is unavailable for extension ${source.extensionId}.`)
        }
      }
      loaded.push(await loadForageExtension(entry, {
        configuration: configured,
        cacheKey: source.entryDigest,
        stderr: (line) => process.stderr.write(`[forage-extension:${source.extensionId}] ${sanitizeExtensionText(
          line,
          knownSecrets.concat(Object.values(payload.extensionSecrets[source.installationId] ?? {})),
        )}\n`),
      }))
    }
    return { extensions: loaded, release: () => lease.release() }
  } catch (error) {
    await lease.release()
    throw error
  }
}

function sanitizeLogData(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') return sanitizeExtensionText(value, secrets)
  if (Array.isArray(value)) return value.slice(0, 1_000).map((item) => sanitizeLogData(item, secrets))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 100)
      .map(([key, item]) => [key, sanitizeLogData(item, secrets)]))
  }
  return value
}

main().catch((error) => {
  emit({ type: 'process_error', error: errorMessage(error) })
  process.exit(1)
})
