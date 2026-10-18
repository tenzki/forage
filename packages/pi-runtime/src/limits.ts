
export const DEFAULT_MAX_TOOL_ROUNDS = 20
export const MAX_TOOL_ROUNDS = 40
export const MAX_CALLS_PER_RESPONSE = 16
export const CALL_LIMIT_MESSAGE = `Tool call not run: at most ${MAX_CALLS_PER_RESPONSE} tool calls run per response.`

export function toolRoundLimit(requested: number | undefined): number {
  return Math.max(1, Math.min(Math.floor(requested ?? DEFAULT_MAX_TOOL_ROUNDS), MAX_TOOL_ROUNDS))
}
