import {
  localExtensionSnapshotSchema,
  type LocalExtensionSnapshot,
} from '@forage/agent-runtime'

import { validateCustomTool, type CustomToolConfig } from './tools'
import { parseRunThread, type RunThread } from './conversation-store'

export const MAX_PAYLOAD_BYTES = 512_000
const MAX_CONTEXT_CHARACTERS = 40_000

export interface RunPayload {
  runId: string
  instructions: string
  prompt: string
  context: string[]
  /** Current bullets under the invocation, sent on follow-up turns. */
  invocationOutline: string[]
  enabledToolIds: string[]
  requiredToolIds: string[]
  customTools: CustomToolConfig[]
  outlineSnapshot?: string
  extensionSnapshot?: LocalExtensionSnapshot
  extensionSecrets: Record<string, Record<string, string>>
  thread?: RunThread
}

function asStrings(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string').slice(0, limit)
}

function stringLines(value: unknown, label: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`Agent invocation has invalid ${label}.`)
  }
  return value as string[]
}

export function decodePayload(encoded: string): RunPayload {
  if (!encoded || encoded.length > MAX_PAYLOAD_BYTES) throw new Error('Invalid agent invocation payload.')
  const value = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Partial<RunPayload>
  if (typeof value.instructions !== 'string' || typeof value.prompt !== 'string') {
    throw new Error('Agent invocation is missing instructions or a prompt.')
  }
  if (!Array.isArray(value.context)) throw new Error('Agent invocation has invalid outline context.')
  const context = stringLines(value.context, 'outline context')
  const invocationOutline = stringLines(value.invocationOutline, 'outline context')
  const contextCharacters = [...context, ...invocationOutline].reduce((total, item) => total + item.length, 0)
  if (context.length + invocationOutline.length > 500 || contextCharacters > MAX_CONTEXT_CHARACTERS) {
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
  const thread = parseRunThread(value.thread)
  return {
    runId: typeof value.runId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.runId)
      ? value.runId : `run-${Date.now()}`,
    instructions: value.instructions.slice(0, 20_000),
    prompt: value.prompt.slice(0, 20_000),
    context,
    invocationOutline,
    enabledToolIds: asStrings(value.enabledToolIds, 50),
    requiredToolIds: asStrings(value.requiredToolIds, 50),
    customTools,
    outlineSnapshot,
    extensionSnapshot,
    extensionSecrets: parseExtensionSecrets(value.extensionSecrets),
    ...(thread ? { thread } : {}),
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

export function isFollowUpTurn(payload: RunPayload): boolean {
  return (payload.thread?.turn ?? 1) > 1
}

/** The user message for one turn: outline context, then the task or the follow-up. */
export function taskMessage(payload: RunPayload): string {
  const context = payload.context.length
    ? `Selected outline context (hierarchy preserved by indentation):\n${payload.context.join('\n')}\n\n`
    : ''
  if (!isFollowUpTurn(payload)) return `${context}Task: ${payload.prompt}`
  const invocationOutline = payload.invocationOutline.length
    ? payload.invocationOutline.join('\n')
    : '(no bullets)'
  return `${context}Outline under the invocation bullet:\n${invocationOutline}\n\nUser follow-up: ${payload.prompt}`
}

const FOLLOW_UP_INSTRUCTIONS = [
  'This is a follow-up turn in an ongoing conversation about your earlier result. The outline context in the latest message is current and takes precedence over earlier turns.',
  'If the user asks a question or wants to learn more, answer in plain text and do not call emit_outline; the outline stays unchanged.',
  'If the user asks to change, extend, or replace the result, call emit_outline with the complete revised result. It replaces your previous output under the invocation bullet; the user\'s own bullets there are kept.',
  'Images generated in earlier turns are already placed in the outline; emit_outline can reference only images generated in this turn.',
  'Do not edit files or run shell commands.',
].join('\n')

export function systemPrompt(instructions: string, followUp = false): string {
  return [
    instructions,
    followUp
      ? FOLLOW_UP_INSTRUCTIONS
      : 'Return the final answer by calling emit_outline. Do not edit files or run shell commands.',
  ].join('\n\n')
}
