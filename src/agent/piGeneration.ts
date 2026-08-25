import { resolveCodexAuth, type CodexAuthConfig, type GenerateInput, type GenerateOptions } from './client'
import { validateGeneratedImage, type GeneratedImageData } from '../editor/generatedImage'
import { PiRpcClient, type PiRpcEvent } from './piSdkClient'
import { safeToolDetail, type ActivityReporter } from './activity'

export type PiOutlineNode =
  | { text: string; children?: PiOutlineNode[] }
  | { image: GeneratedImageData }

export interface PiGenerateOptions extends GenerateOptions {
  onOutline?: (nodes: PiOutlineNode[]) => void
  onActivity?: ActivityReporter
}

interface RunPayload {
  instructions: string
  prompt: string
  context: string[]
  enabledToolIds: string[]
  customTools: Array<{ name: string; description: string; urlTemplate: string }>
  /** Serialized outline snapshot for the search_outline tool. */
  outlineSnapshot?: string
}

export async function generateWithPi(
  auth: CodexAuthConfig,
  input: GenerateInput & { outlineSnapshot?: string },
  options: PiGenerateOptions,
): Promise<string> {
  const resolvedAuth = await resolveCodexAuth(auth, options.signal)
  const client = new PiRpcClient()
  const allowedTools = new Set(input.agent?.toolIds ?? [])
  const enabledToolIds = (input.enabledToolIds ?? []).filter((id) => allowedTools.has(id))
  const enabledSet = new Set(enabledToolIds)
  const customTools = (input.customTools ?? [])
    .filter((tool) => enabledSet.has(tool.id))
    .map(({ name, description, urlTemplate }) => ({ name, description, urlTemplate }))
  let text = ''
  let outline: PiOutlineNode[] | null = null
  const toolDetails = new Map<string, string>()
  const startedAt = Date.now()
  let outputStarted = false
  const thinkingId = `thinking-${startedAt}`
  const outputId = `output-${startedAt}`

  options.onActivity?.({ id: thinkingId, phase: 'start', kind: 'thinking', label: 'Thinking' })

  const beginOutput = () => {
    if (outputStarted) return
    outputStarted = true
    options.onActivity?.({ id: thinkingId, phase: 'complete', kind: 'thinking', label: 'Thinking', durationMs: Date.now() - startedAt })
    options.onActivity?.({ id: outputId, phase: 'start', kind: 'output', label: 'Writing outline' })
  }

  const unsubscribe = client.onEvent((event) => {
    const delta = textDelta(event)
    if (delta !== null) {
      beginOutput()
      text += delta
      options.onDelta(text)
    }
    const toolName = toolStart(event)
    if (toolName) {
      const toolId = typeof event.toolCallId === 'string' ? `tool-${event.toolCallId}` : `tool-${Date.now()}-${toolName}`
      const detail = safeToolDetail(toolName, event.args)
      toolDetails.set(toolId, detail)
      options.onActivity?.({
        id: toolId,
        phase: 'start',
        kind: 'tool',
        label: toolName,
        detail,
      })
      options.onToolActivity?.([`${toolName}: ${detail}`])
    }
    if (event.type === 'tool_execution_end' && typeof event.toolName === 'string') {
      const toolId = typeof event.toolCallId === 'string' ? `tool-${event.toolCallId}` : undefined
      const startDetail = toolId ? toolDetails.get(toolId) : undefined
      const outcome = event.isError ? 'Failed' : 'Completed'
      if (toolId) toolDetails.delete(toolId)
      options.onActivity?.({
        id: toolId ?? `tool-${event.toolName}`,
        phase: event.isError ? 'error' : 'complete',
        kind: 'tool',
        label: event.toolName,
        detail: startDetail ? `${startDetail} · ${outcome}` : outcome,
      })
    }
    const emitted = emittedOutline(event)
    if (emitted) {
      beginOutput()
      options.onActivity?.({ id: outputId, phase: 'complete', kind: 'output', label: 'Outline ready', durationMs: Date.now() - startedAt })
      outline = emitted
      options.onOutline?.(emitted)
    }
    if (event.type === 'agent_settled' && !outline) {
      beginOutput()
      options.onActivity?.({ id: outputId, phase: 'complete', kind: 'output', label: 'Response ready', durationMs: Date.now() - startedAt })
    }
    if (event.type === 'process_error') {
      options.onActivity?.({ id: thinkingId, phase: 'error', kind: 'error', label: 'Agent error', detail: String(event.error ?? 'Unknown agent error') })
    }
  })

  const abort = () => void client.abort().catch(() => undefined)
  options.signal?.addEventListener('abort', abort, { once: true })
  try {
    await client.start({
      provider: resolvedAuth.mode === 'subscription' ? 'openai-codex' : 'openai',
      modelId: input.agent?.modelId || auth.modelId,
      apiKey: resolvedAuth.accessToken,
      accountId: resolvedAuth.mode === 'subscription' ? resolvedAuth.accountId : '',
      ...(resolvedAuth.mode === 'subscription' ? { oauthExpires: resolvedAuth.expires } : {}),
    })
    if (options.signal?.aborted) throw new DOMException('Generation cancelled.', 'AbortError')
    const settled = client.waitForSettled()
    await client.prompt(encodePayload({
      instructions: [input.agent?.systemPrompt, input.skill.systemPrompt].filter(Boolean).join('\n\n'),
      prompt: input.prompt,
      context: input.context,
      enabledToolIds,
      customTools,
      outlineSnapshot: input.outlineSnapshot,
    }))
    await settled
    if (options.signal?.aborted) throw new DOMException('Generation cancelled.', 'AbortError')
    if (!outline && !text) throw new Error(`Pi returned no outline. ${client.getStderr()}`)
    return text
  } finally {
    options.signal?.removeEventListener('abort', abort)
    unsubscribe()
    await client.stop()
  }
}

function textDelta(event: PiRpcEvent): string | null {
  if (event.type !== 'message_update') return null
  const update = asRecord(event.assistantMessageEvent)
  return update?.type === 'text_delta' && typeof update.delta === 'string' ? update.delta : null
}

function toolStart(event: PiRpcEvent): string | null {
  return event.type === 'tool_execution_start' && typeof event.toolName === 'string'
    ? event.toolName
    : null
}

function emittedOutline(event: PiRpcEvent): PiOutlineNode[] | null {
  if (event.type !== 'tool_execution_end' || event.toolName !== 'emit_outline') return null
  const details = asRecord(asRecord(event.result)?.details)
  if (details?.action !== 'emit_outline' || !Array.isArray(details.nodes)) return null
  const nodes = details.nodes.flatMap(validateNode)
  return nodes.length ? nodes : null
}

function validateNode(value: unknown): PiOutlineNode[] {
  const node = asRecord(value)
  if (!node) return []
  if (node.type === 'image') {
    const image = validateGeneratedImage(node.image)
    return image ? [{ image }] : []
  }
  if (typeof node.text !== 'string' || !node.text.trim()) return []
  const children = Array.isArray(node.children) ? node.children.flatMap(validateNode) : []
  return [{ text: node.text.trim(), ...(children.length ? { children } : {}) }]
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

export function encodePayload(payload: RunPayload): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload))
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192))
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
