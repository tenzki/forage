import { describe, expect, it } from 'vitest'
import { FinalResponseTracker, finalAssistantText } from './final-response'

describe('finalAssistantText', () => {
  it('recovers text from the last assistant message when no streaming delta was observed', () => {
    expect(finalAssistantText([
      { role: 'assistant', content: [{ type: 'text', text: 'Earlier' }] },
      { role: 'toolResult', content: [{ type: 'text', text: 'Tool output' }] },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Hidden' },
          { type: 'text', text: 'Final ' },
          { type: 'text', text: 'answer' },
        ],
      },
    ])).toBe('Final answer')
  })

  it('returns an empty string when there is no assistant text', () => {
    expect(finalAssistantText([{ role: 'assistant', content: [{ type: 'toolCall' }] }])).toBe('')
  })
})

describe('FinalResponseTracker', () => {
  it('holds the last completed assistant response until the agent truly settles', () => {
    const tracker = new FinalResponseTracker()

    tracker.recordAgentEnd([
      { role: 'assistant', content: [{ type: 'text', text: 'First run' }] },
    ], false)
    tracker.recordAgentEnd([
      { role: 'assistant', content: [{ type: 'text', text: 'Queued continuation' }] },
    ], false)

    expect(tracker.settledEvent()).toEqual({ type: 'agent_settled', text: 'Queued continuation' })
  })

  it('does not retain the response from a run that Pi will retry', () => {
    const tracker = new FinalResponseTracker()

    tracker.recordAgentEnd([
      { role: 'assistant', content: [{ type: 'text', text: 'Incomplete retry response' }] },
    ], true)

    expect(tracker.settledEvent()).toEqual({ type: 'agent_settled' })
  })

  it('clears earlier text when the final continuation has no assistant response', () => {
    const tracker = new FinalResponseTracker()

    tracker.recordAgentEnd([
      { role: 'assistant', content: [{ type: 'text', text: 'Earlier run' }] },
    ], false)
    tracker.recordAgentEnd([
      { role: 'assistant', content: [{ type: 'toolCall' }] },
    ], false)

    expect(tracker.settledEvent()).toEqual({ type: 'agent_settled' })
  })
})
