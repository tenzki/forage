function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null
}

export function finalAssistantText(messages: unknown): string {
  if (!Array.isArray(messages)) return ''
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index])
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue
    const text = message.content
      .map(asRecord)
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part!.text as string)
      .join('')
      .trim()
    if (text) return text
  }
  return ''
}

export class FinalResponseTracker {
  private text = ''

  recordAgentEnd(messages: unknown, willRetry: boolean): void {
    if (willRetry) return
    this.text = finalAssistantText(messages)
  }

  settledEvent(): { type: 'agent_settled'; text?: string } {
    return { type: 'agent_settled', ...(this.text ? { text: this.text } : {}) }
  }
}
