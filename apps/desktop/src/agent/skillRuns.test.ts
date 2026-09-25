import { describe, expect, it } from 'vitest'
import type { ActivityCall } from '../components/Agent/ActivitySidebar'
import { groupSkillCalls } from './skillCalls'
import { conversationReply, parseSteeredPrompt, steeredPrompt } from './skillRuns'

function call(id: string, timestamp: number, extra: Partial<ActivityCall> = {}): ActivityCall {
  return {
    id, kind: 'skill', label: 'Run /research tides', detail: 'tides', status: 'complete',
    timestamp, nodeId: 'bullet-1', events: [], ...extra,
  }
}

describe('steered skill prompts', () => {
  it('round-trips the original request and the steering note', () => {
    const prompt = steeredPrompt('spaced repetition', 'One bullet per technique.', 2, ['- Leitner boxes', '  - Five boxes'])

    expect(prompt).toContain('Previous result:\n- Leitner boxes\n  - Five boxes')
    expect(parseSteeredPrompt(prompt)).toEqual({
      basePrompt: 'spaced repetition',
      note: 'One bullet per technique.',
      iteration: 2,
    })
  })

  it('leaves an ordinary prompt alone', () => {
    expect(parseSteeredPrompt('spaced repetition')).toEqual({ basePrompt: 'spaced repetition' })
  })
})

describe('conversation replies', () => {
  it('resumes a local call at the next turn and names the version it replaces', () => {
    const [group] = groupSkillCalls([
      call('run-1', 1, { thread: { callId: 'run-1', turn: 1 } }),
      call('run-2', 2, { thread: { callId: 'run-1', turn: 2 }, note: 'Why?', answer: 'Because.' }),
      call('run-3', 3, { thread: { callId: 'run-1', turn: 3 }, note: 'Stop', status: 'cancelled' }),
    ])

    expect(conversationReply(group!, 'Shorter please')).toEqual({
      invocationNodeId: 'bullet-1', skillLabel: 'research', prompt: 'Shorter please',
      steering: { note: 'Shorter please', basePrompt: 'tides', iteration: 4 },
      conversation: { callId: 'run-1', turn: 4, replacesRunId: 'run-1' },
    })
  })

  it('takes the legacy path for calls without a conversation', () => {
    const [serverCall] = groupSkillCalls([call('run-1', 1)])
    expect(conversationReply(serverCall!, 'Shorter please')).toBeNull()
  })

  it('starts the conversation over when no turn completed', () => {
    const [group] = groupSkillCalls([call('run-1', 1, { thread: { callId: 'run-1', turn: 1 }, status: 'error' })])
    const reply = conversationReply(group!, 'Try again')

    expect(reply?.conversation).toEqual({ callId: 'run-1', turn: 1 })
    expect(parseSteeredPrompt(reply!.prompt)).toMatchObject({ basePrompt: 'tides', note: 'Try again' })
  })
})
