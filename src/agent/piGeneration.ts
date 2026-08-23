import { resolveAccessToken, type CodexAuthConfig, type GenerateInput, type GenerateOptions } from './client'
import { validateGeneratedImage, type GeneratedImageData } from '../editor/generatedImage'
import { PiRpcClient, type PiRpcEvent } from './piRpcClient'

export type PiOutlineNode =
  | { text: string; children?: PiOutlineNode[] }
  | { image: GeneratedImageData }

export interface PiGenerateOptions extends GenerateOptions {
  onOutline?: (nodes: PiOutlineNode[]) => void
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
  const apiKey = await resolveAccessToken(auth, options.signal)
  const client = new PiRpcClient()
  const allowedTools = new Set(input.agent?.toolIds ?? [])
  const enabledToolIds = (input.enabledToolIds ?? []).filter((id) => allowedTools.has(id))
  const enabledSet = new Set(enabledToolIds)
  const customTools = (input.customTools ?? [])
    .filter((tool) => enabledSet.has(tool.id))
    .map(({ name, description, urlTemplate }) => ({ name, description, urlTemplate }))
  let text = ''
  let outline: PiOutlineNode[] | null = null
  let activity: string[] = []

  const unsubscribe = client.onEvent((event) => {
    const delta = textDelta(event)
    if (delta !== null) {
      text += delta
      options.onDelta(text)
    }
    const toolName = toolStart(event)
    if (toolName) {
      activity = [...activity, `calling ${toolName}`]
      options.onToolActivity?.(activity)
    }
    const emitted = emittedOutline(event)
    if (emitted) {
      outline = emitted
      options.onOutline?.(emitted)
    }
  })

  const abort = () => void client.abort().catch(() => undefined)
  options.signal?.addEventListener('abort', abort, { once: true })
  try {
    await client.start({
      provider: auth.mode === 'subscription' ? 'openai-codex' : 'openai',
      modelId: input.agent?.modelId || auth.modelId,
      apiKey,
      accountId: auth.mode === 'subscription' ? auth.oauthCredential?.accountId ?? '' : '',
    })
    if (options.signal?.aborted) throw new DOMException('Generation cancelled.', 'AbortError')
    const settled = client.waitForSettled()
    await client.prompt(`/ai-chat-run ${encodePayload({
      instructions: [input.agent?.systemPrompt, input.skill.systemPrompt].filter(Boolean).join('\n\n'),
      prompt: input.prompt,
      context: input.context,
      enabledToolIds,
      customTools,
      outlineSnapshot: input.outlineSnapshot,
    })}`)
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
