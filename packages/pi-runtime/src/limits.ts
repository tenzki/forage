import type { AgentSession } from '@earendil-works/pi-coding-agent'
import { UNAUTHORIZED_TOOL_MESSAGE } from './tool-policy'

export const DEFAULT_MAX_TOOL_ROUNDS = 8
export const MAX_TOOL_ROUNDS = 20
export const MAX_CALLS_PER_RESPONSE = 16
export const CALL_LIMIT_MESSAGE = `Tool call not run: at most ${MAX_CALLS_PER_RESPONSE} tool calls run per response.`
export const ROUND_LIMIT_MESSAGE = 'Tool call not run: the tool round limit was reached.'

export function toolRoundLimit(requested: number | undefined): number {
  return Math.max(1, Math.min(Math.floor(requested ?? DEFAULT_MAX_TOOL_ROUNDS), MAX_TOOL_ROUNDS))
}

export interface TurnGuards {
  /** Whether the turn tried to start a tool round past the limit. */
  roundLimitReached: () => boolean
  dispose: () => void
}

/**
 * Apply the run limits Pi does not enforce itself. A response that would start tool
 * round `maxToolRounds + 1` aborts the turn; calls past the per-response cap are
 * answered with a tool error; results of tools outside the effective set reach the
 * model as "not authorized" instead of Pi's "not found".
 */
export function installTurnGuards(session: AgentSession, options: {
  authorizedToolNames: ReadonlySet<string>
  maxToolRounds: number
}): TurnGuards {
  const agent = session.agent
  let rounds = 0
  let limitReached = false

  const beforeToolCall = agent.beforeToolCall
  agent.beforeToolCall = async (context, signal) => {
    if (limitReached) return { block: true, reason: ROUND_LIMIT_MESSAGE }
    const calls = context.assistantMessage.content.filter((part) => part.type === 'toolCall')
    if (calls.findIndex((call) => call.id === context.toolCall.id) >= MAX_CALLS_PER_RESPONSE) {
      return { block: true, reason: CALL_LIMIT_MESSAGE }
    }
    return beforeToolCall?.(context, signal)
  }

  const convertToLlm = agent.convertToLlm
  agent.convertToLlm = async (messages) => (await convertToLlm(messages)).map((message) => (
    message.role === 'toolResult' && !options.authorizedToolNames.has(message.toolName)
      ? { ...message, content: [{ type: 'text' as const, text: UNAUTHORIZED_TOOL_MESSAGE }], isError: true }
      : message
  ))

  const unsubscribe = session.subscribe((event) => {
    if (event.type === 'message_end' && event.message.role === 'assistant'
      && event.message.content.some((part) => part.type === 'toolCall')) {
      rounds += 1
    }
    if (event.type === 'turn_start' && rounds >= options.maxToolRounds && !limitReached) {
      limitReached = true
      void session.abort().catch(() => undefined)
    }
  })

  return {
    roundLimitReached: () => limitReached,
    dispose: () => {
      unsubscribe()
      agent.beforeToolCall = beforeToolCall
      agent.convertToLlm = convertToLlm
    },
  }
}
