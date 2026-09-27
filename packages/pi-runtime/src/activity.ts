import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import {
  activityEventSchema,
  boundedActivityId,
  boundedSafeError,
  toolActivityDetail,
  type ActivityEvent,
} from '@forage/agent-runtime'
import { EMIT_OUTLINE_TOOL } from './emit-outline'

type ActivityInput = Omit<ActivityEvent, 'id' | 'sequence'> & { id?: string }

/** Maps one turn's Pi session events to the activity vocabulary both environments persist. */
export class ActivityMapper {
  private sequence = 0
  private thinking: 'idle' | 'running' | 'settled' = 'idle'
  private readonly thinkingId: string
  private readonly toolDetails = new Map<string, string>()

  constructor(runId: string, private readonly emit: (event: ActivityEvent) => void = () => undefined) {
    this.thinkingId = boundedActivityId(`thinking-${runId}`, 1)
  }

  handle(event: AgentSessionEvent): void {
    switch (event.type) {
      case 'agent_start':
        if (this.thinking !== 'idle') return
        this.thinking = 'running'
        this.report({ id: this.thinkingId, phase: 'start', kind: 'thinking', label: 'Thinking', status: 'running' })
        return
      case 'message_end':
        if (event.message.role === 'assistant') this.settleThinking('complete', 'success')
        return
      case 'tool_execution_start':
        if (event.toolName === EMIT_OUTLINE_TOOL) return
        this.toolDetails.set(event.toolCallId, toolActivityDetail(event.toolName, record(event.args)))
        this.report({
          id: this.toolId(event.toolCallId),
          callId: this.toolId(event.toolCallId),
          phase: 'start',
          kind: 'tool',
          label: label(event.toolName),
          detail: this.toolDetails.get(event.toolCallId),
          status: 'running',
        })
        return
      case 'tool_execution_end':
        if (event.toolName === EMIT_OUTLINE_TOOL) {
          if (!event.isError) this.report({ phase: 'complete', kind: 'output', label: 'Response ready', status: 'success' })
          return
        }
        this.report({
          id: this.toolId(event.toolCallId),
          callId: this.toolId(event.toolCallId),
          phase: event.isError ? 'error' : 'complete',
          kind: 'tool',
          label: label(event.toolName),
          detail: event.isError
            ? `${this.toolDetails.get(event.toolCallId) ?? 'No arguments'}\n${resultText(event.result)}`.slice(0, 2_000)
            : this.toolDetails.get(event.toolCallId),
          status: event.isError ? 'error' : 'success',
        })
        return
      default:
    }
  }

  /** The turn ended with an inline answer instead of an outline. */
  answered(): void {
    this.settleThinking('complete', 'success')
    this.report({ phase: 'complete', kind: 'output', label: 'Answer ready', status: 'success' })
  }

  cancelled(): void {
    this.settleThinking('cancelled', 'cancelled')
    this.report({ phase: 'cancelled', kind: 'status', label: 'Cancelled', status: 'cancelled' })
  }

  failed(): void {
    this.settleThinking('error', 'error')
  }

  private settleThinking(phase: 'complete' | 'error' | 'cancelled', status: 'success' | 'error' | 'cancelled'): void {
    if (this.thinking !== 'running') return
    this.thinking = 'settled'
    this.report({ id: this.thinkingId, phase, kind: 'thinking', label: 'Thinking', status })
  }

  private toolId(toolCallId: string): string {
    return boundedActivityId(toolCallId, this.sequence + 1)
  }

  private report(event: ActivityInput): void {
    this.sequence += 1
    this.emit(activityEventSchema.parse({ ...event, id: event.id ?? `activity-${this.sequence}`, sequence: this.sequence }))
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function label(value: string): string {
  return value.trim().slice(0, 200) || 'unknown'
}

function resultText(result: unknown): string {
  const content = record(result).content
  const text = Array.isArray(content)
    ? content.map((part) => (typeof record(part).text === 'string' ? record(part).text as string : '')).join('').trim()
    : ''
  return boundedSafeError(new Error(text || 'Tool execution failed.'))
}
