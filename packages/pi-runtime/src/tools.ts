import type { Static, Tool, TSchema, ToolResultMessage } from '@earendil-works/pi-ai'

/** Forage's private tool boundary. Extensions never receive a durable Harness. */
export type ToolDefinition<P extends TSchema = TSchema> = Tool<P> & {
  label: string
  replay?: 'safe' | 'unsafe'
  execute(callId: string, input: Static<P>, signal?: AbortSignal, onUpdate?: unknown, context?: unknown): Promise<{
    content: ToolResultMessage['content']
    details?: unknown
    terminate?: boolean
  }>
}

export function defineTool<P extends TSchema>(tool: ToolDefinition<P>): ToolDefinition<P> {
  return tool
}

/** Stable IPC vocabulary; independent of upstream event-format changes. */
export type PiSessionEvent =
  | { type: 'agent_start' }
  | { type: 'message_end'; message: { role: string } }
  | { type: 'message_update'; assistantMessageEvent: { type: 'text_delta'; delta: string } }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool_execution_end'; toolCallId: string; toolName: string; result: unknown; isError: boolean }
