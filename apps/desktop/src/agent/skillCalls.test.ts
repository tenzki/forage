import { describe, expect, it } from 'vitest'
import type { ActivityCall } from '../components/Agent/ActivitySidebar'
import { groupSkillCalls, skillCallThread } from './skillCalls'

function run(id: string, timestamp: number, extra: Partial<ActivityCall> = {}): ActivityCall {
  return {
    id, kind: 'skill', label: 'Run /research tides', detail: 'tides', nodeId: 'bullet-1',
    status: 'complete', timestamp, events: [], ...extra,
  }
}

describe('skill call grouping', () => {
  it('groups a conversation by call id, so an identical rerun from the outline starts a new call', () => {
    const groups = groupSkillCalls([
      run('run-1', 1, { thread: { callId: 'run-1', turn: 1 } }),
      run('run-2', 2, { thread: { callId: 'run-1', turn: 2 }, note: 'Why?', answer: 'The moon.' }),
      run('run-3', 3, { thread: { callId: 'run-3', turn: 1 } }),
    ])

    expect(groups.map((group) => [group.id, group.iterations.map(({ call }) => call.id)])).toEqual([
      ['run-3', ['run-3']],
      ['run-1', ['run-1', 'run-2']],
    ])
    expect(groups[1]).toMatchObject({ conversational: true, versions: 1 })
  })

  it('keeps the bullet-and-label heuristic for runs without a conversation', () => {
    const groups = groupSkillCalls([
      run('legacy-1', 1),
      run('legacy-2', 2, { note: 'Shorter' }),
      run('threaded', 3, { thread: { callId: 'threaded', turn: 1 } }),
    ])

    expect(groups.map((group) => group.iterations.length)).toEqual([1, 2])
    expect(groups[1]).toMatchObject({ conversational: false, versions: 2 })
  })
})

describe('skill call thread', () => {
  it('numbers versions by outline-producing turns and shows answers inline', () => {
    const [group] = groupSkillCalls([
      run('run-1', 1, { thread: { callId: 'run-1', turn: 1 }, events: [
        { id: 'result-1', kind: 'output', label: 'Open result', nodeId: 'out-1', status: 'complete', timestamp: 1 },
      ] }),
      run('run-2', 2, { thread: { callId: 'run-1', turn: 2 }, note: 'Which source?', answer: 'NOAA.' }),
      run('run-3', 3, { thread: { callId: 'run-1', turn: 3 }, note: 'Stop', status: 'cancelled' }),
      run('run-4', 4, { thread: { callId: 'run-1', turn: 4 }, note: 'Add NOAA as a bullet' }),
      run('run-5', 5, { thread: { callId: 'run-1', turn: 5 }, note: 'And why?', status: 'running', answer: 'Because' }),
    ])

    expect(group!.versions).toBe(2)
    expect(group!.iterations.map(({ version }) => version)).toEqual([1, null, null, 2, null])
    expect(skillCallThread(group!).map((item) => {
      if (item.type === 'note') return `note:${item.text}`
      if (item.type === 'answer') return `answer:${item.text}:${item.streaming ? 'streaming' : 'done'}`
      if (item.type === 'output') return `v${item.version}${item.superseded ? ':superseded' : ''}`
      return item.type
    })).toEqual([
      'v1:superseded',
      'note:Which source?', 'answer:NOAA.:done',
      'note:Stop',
      'note:Add NOAA as a bullet', 'v2',
      'note:And why?', 'answer:Because:streaming',
    ])
  })

  it('shows a running reply as a pending answer until its outcome is known', () => {
    const [group] = groupSkillCalls([
      run('run-1', 1, { thread: { callId: 'run-1', turn: 1 } }),
      run('run-2', 2, { thread: { callId: 'run-1', turn: 2 }, note: 'More detail', status: 'running' }),
    ])

    const thread = skillCallThread(group!)
    expect(thread[thread.length - 1]).toMatchObject({ type: 'answer', text: '', streaming: true })
    expect(group!.versions).toBe(1)
  })
})
