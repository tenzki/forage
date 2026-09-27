import type { Api, Model } from '@earendil-works/pi-ai'
import type { AgentSessionEvent, ModelRuntime } from '@earendil-works/pi-coding-agent'
import { AgentRuntimeError, isAbortError } from '@forage/agent-runtime'
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
import { conversationDirectory, createFileConversationStore, runPiTurn } from '@forage/pi-runtime'

import {
  createCustomHttpTool,
  createSearchOutlineTool,
  createWebFetchTool,
  createWebSearchTool,
  type OutlineSnapshotNode,
} from './tools'
import { decodePayload, turnRequest, type RunPayload } from './payload'
import { adaptExtensionTools } from './extension-tools'

export interface RunCommandDependencies {
  modelRuntime: ModelRuntime
  model: Model<Api>
  /** The model credential, redacted from reported errors. */
  accessToken: string
  /** Pi agent directory; call conversations are stored under it. */
  agentDir: string
  signal: AbortSignal
  emit: (value: unknown) => void
}

type ExtensionOutcome = 'completed' | 'failed' | 'cancelled'

/**
 * Run one encoded sidecar payload as a shared Pi turn and report it over the JSONL
 * protocol. Always ends with exactly one `agent_settled` or `process_error` event.
 */
export async function runCommand(encodedPayload: string, dependencies: RunCommandDependencies): Promise<void> {
  const { emit, signal } = dependencies
  let currentSecrets: string[] = [dependencies.accessToken]
  let finishExtensions: ((outcome: ExtensionOutcome) => Promise<void>) | undefined
  let extensionOutcome: ExtensionOutcome = 'failed'

  try {
    const payload = decodePayload(encodedPayload)
    currentSecrets = currentSecrets.concat(Object.values(payload.extensionSecrets).flatMap((secrets) => Object.values(secrets)))
    const knownSecrets = currentSecrets
    const outlineSnapshot = parseOutlineSnapshot(payload.outlineSnapshot)
    const generatedImages = new Map<string, { src: string; prompt: string }>()

    const toolSet = new Set(payload.enabledToolIds)
    const customToolConfigs = payload.customTools.filter((t) => toolSet.has(t.name))
    const admittedExtensions = await loadAdmittedExtensions(payload, customToolConfigs.map((tool) => tool.name), knownSecrets)
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
    const emitLog = (entry: Parameters<NonNullable<Parameters<LoadedForageExtension['runStart']>[1]['onLog']>>[0]) => emit({
      type: 'extension_log',
      ...entry,
      message: sanitizeExtensionText(entry.message, knownSecrets),
      ...(entry.data === undefined ? {} : { data: sanitizeLogData(entry.data, knownSecrets) }),
    })
    const extensionTools = adaptExtensionTools(extensions, authorizedExtensionTools, {
      images: generatedImages,
      signal,
      secrets: payload.extensionSecrets,
      onProgress: (installationId, extensionId, toolId, progress) => emit({
        type: 'extension_progress', installationId, extensionId, toolName: toolId, progress,
      }),
      onLog: emitLog,
    })

    const extensionExecution = { signal, onLog: emitLog }
    finishExtensions = async (outcome) => {
      try {
        await runExtensionEndHooks(extensions, payload.runId, outcome, extensionExecution)
      } finally {
        await admittedExtensions.release()
      }
    }
    await runExtensionStartHooks(extensions, payload.runId, extensionExecution)

    const forwardSessionEvent = (event: AgentSessionEvent) => {
      if (event.type === 'message_update') {
        emit(event)
      } else if (event.type === 'tool_execution_start') {
        emit({
          type: 'tool_execution_start',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
          ...(extensionToolOwners.get(event.toolName) ?? {}),
        })
      } else if (event.type === 'tool_execution_end') {
        emit({
          type: 'tool_execution_end',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          result: event.result,
          isError: event.isError,
          ...(extensionToolOwners.get(event.toolName) ?? {}),
        })
      }
    }

    const outcome = await runPiTurn(turnRequest(payload), {
      modelRuntime: dependencies.modelRuntime,
      model: dependencies.model,
      piTools: ({ sources }) => [
        createWebSearchTool(),
        createWebFetchTool(sources),
        createSearchOutlineTool(() => outlineSnapshot),
        ...customToolConfigs.map(createCustomHttpTool),
        ...extensionTools,
      ],
      images: generatedImages,
      conversation: createFileConversationStore(conversationDirectory(dependencies.agentDir)),
      onSessionEvent: forwardSessionEvent,
    }, { signal, agentDir: dependencies.agentDir })

    extensionOutcome = 'completed'
    emit(outcome.type === 'outline'
      ? { type: 'agent_settled', outcome: 'outline' }
      : { type: 'agent_settled', outcome: 'text', text: outcome.text })
  } catch (error) {
    if (signal.aborted || isAbortError(error)) {
      extensionOutcome = 'cancelled'
      emit({ type: 'agent_settled', outcome: 'text' })
    } else if (error instanceof AgentRuntimeError && error.code === 'empty_response') {
      // The desktop retries an empty turn once; its transcript was already rolled back.
      extensionOutcome = 'completed'
      emit({ type: 'agent_settled', outcome: 'text' })
    } else {
      emit({ type: 'process_error', error: sanitizeExtensionText(errorMessage(error), currentSecrets) })
    }
  } finally {
    if (finishExtensions) {
      try { await finishExtensions(extensionOutcome) } catch (error) {
        process.stderr.write(`[forage-extension] run:end failed: ${sanitizeExtensionText(errorMessage(error), currentSecrets)}\n`)
      }
    }
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parseOutlineSnapshot(value: string | undefined): OutlineSnapshotNode[] {
  if (!value) return []
  try { return JSON.parse(value) as OutlineSnapshotNode[] } catch { return [] }
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
