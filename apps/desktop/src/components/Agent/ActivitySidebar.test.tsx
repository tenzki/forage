import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ActivitySidebar, type ActivityCall } from './ActivitySidebar'

const researchRun: ActivityCall = {
  id: 'skill-1',
  kind: 'skill',
  label: 'Run /research tauri',
  detail: 'tauri',
  nodeId: 'bullet-1',
  status: 'complete',
  timestamp: 1,
  durationMs: 1200,
  events: [
    { id: 'thinking-1', kind: 'thinking', label: 'Thinking', status: 'complete', timestamp: 1 },
    { id: 'tool-1', kind: 'tool', label: 'web_search', detail: 'query: Tauri shell plugin', status: 'complete', timestamp: 2, durationMs: 800 },
    { id: 'tool-2', kind: 'tool', label: 'web_fetch', detail: 'url: https://v2.tauri.app/plugin/shell/', status: 'complete', timestamp: 3 },
    { id: 'result-1', kind: 'output', label: 'Open result', status: 'complete', timestamp: 4, nodeId: 'bullet-9' },
  ],
}

const describeNode = (nodeId: string) => ({
  'bullet-1': { title: 'Shell plugins', bulletCount: 3 },
  'bullet-9': { title: 'Tauri findings', bulletCount: 4 },
}[nodeId] ?? null)

describe('activity sidebar', () => {
  it('lists skill calls with their bullet, status and version', () => {
    render(<ActivitySidebar calls={[researchRun]} onClear={() => undefined} describeNode={describeNode} />)

    expect(screen.getByRole('complementary', { name: 'Agent activity' })).toBeTruthy()
    expect(screen.getByText('/research tauri')).toBeTruthy()
    expect(screen.getByText(/On “Shell plugins”/)).toBeTruthy()
    expect(screen.getByText('Done')).toBeTruthy()
    expect(screen.getByText(/v1\s+·\s+1 iteration/)).toBeTruthy()
    expect(screen.getByText('1 skill call')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Clear activity' })).toBeTruthy()
  })

  it('shows an empty state when no activity has occurred', () => {
    render(<ActivitySidebar calls={[]} onClear={() => undefined} />)

    expect(screen.getByText('No activity yet')).toBeTruthy()
    expect(screen.getByText('Run a skill to see its work here.')).toBeTruthy()
  })

  it('opens a call to show its searches, pages and written bullets', () => {
    const onOpenNode = vi.fn()
    render(<ActivitySidebar calls={[researchRun]} onClear={() => undefined} onOpenNode={onOpenNode} describeNode={describeNode} />)

    fireEvent.click(screen.getByRole('button', { name: 'Open /research tauri' }))

    expect(screen.getByText('Tauri shell plugin')).toBeTruthy()
    expect(screen.getByText('1 query')).toBeTruthy()
    expect(screen.getByText('v2.tauri.app')).toBeTruthy()
    expect(screen.getByText('+4')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Go to bullets' }))
    expect(onOpenNode).toHaveBeenCalledWith('bullet-9', 'bullet-1')

    fireEvent.click(screen.getByRole('button', { name: 'All activity' }))
    expect(screen.getByRole('button', { name: 'Open /research tauri' })).toBeTruthy()
  })

  it('groups steered runs of a skill on one bullet into versions and sends new notes', () => {
    const onSteer = vi.fn()
    const steered: ActivityCall = {
      id: 'skill-2', kind: 'skill', label: 'Run /research tauri', detail: 'tauri', nodeId: 'bullet-1',
      note: 'Prefer the official docs.', status: 'complete', timestamp: 10, events: [],
    }
    render(<ActivitySidebar
      calls={[researchRun, steered]}
      onClear={() => undefined}
      describeNode={describeNode}
      canSteer={() => true}
      onSteer={onSteer}
    />)

    expect(screen.getAllByRole('button', { name: 'Open /research tauri' })).toHaveLength(1)
    expect(screen.getByText(/v2\s+·\s+2 iterations/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Open /research tauri' }))
    expect(screen.getByText('Prefer the official docs.')).toBeTruthy()
    expect(screen.getByText('replaced by v2')).toBeTruthy()

    const composer = screen.getByRole('textbox', { name: 'Steer /research tauri' })
    fireEvent.change(composer, { target: { value: 'Add a todo for a weekly review.' } })
    fireEvent.keyDown(composer, { key: 'Enter', metaKey: true })
    expect(onSteer).toHaveBeenCalledWith(expect.objectContaining({ id: 'skill-1' }), 'Add a todo for a weekly review.')
  })

  it('shows a conversation with inline answers and a reply composer', () => {
    const onSteer = vi.fn()
    const first: ActivityCall = { ...researchRun, thread: { callId: 'skill-1', turn: 1 } }
    const reply: ActivityCall = {
      id: 'skill-2', kind: 'skill', label: 'Run /research tauri', detail: 'tauri', nodeId: 'bullet-1',
      thread: { callId: 'skill-1', turn: 2 }, note: 'Which page covers permissions?',
      answer: 'The shell plugin page.\n\nIt lists the scopes.', status: 'complete', timestamp: 10, events: [],
    }
    render(<ActivitySidebar
      calls={[first, reply]}
      onClear={() => undefined}
      describeNode={describeNode}
      canSteer={() => true}
      onSteer={onSteer}
    />)

    expect(screen.getByText(/v1\s+·\s+2 iterations/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open /research tauri' }))
    expect(screen.getByText('Which page covers permissions?')).toBeTruthy()
    expect(screen.getByText('The shell plugin page.')).toBeTruthy()
    expect(screen.getByText('It lists the scopes.')).toBeTruthy()
    expect(screen.queryByText('replaced by v2')).toBeNull()
    expect(screen.getByText('Answers here, or replaces v1 with v2')).toBeTruthy()

    const composer = screen.getByRole('textbox', { name: 'Reply to /research tauri' })
    fireEvent.change(composer, { target: { value: 'Add the scopes as bullets.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send reply' }))
    expect(onSteer).toHaveBeenCalledWith(expect.objectContaining({ id: 'skill-1' }), 'Add the scopes as bullets.')
  })

  it('shows a running reply as a pending answer', () => {
    const first: ActivityCall = { ...researchRun, thread: { callId: 'skill-1', turn: 1 } }
    const reply: ActivityCall = {
      id: 'skill-2', kind: 'skill', label: 'Run /research tauri', detail: 'tauri', nodeId: 'bullet-1',
      thread: { callId: 'skill-1', turn: 2 }, note: 'More detail', status: 'running', timestamp: 10, events: [],
    }
    render(<ActivitySidebar calls={[first, reply]} onClear={() => undefined} canSteer={() => true} onSteer={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open /research tauri' }))

    expect(screen.getByText('Thinking…')).toBeTruthy()
    expect(screen.getByRole('textbox', { name: 'Reply to /research tauri' })).toHaveProperty('disabled', true)
  })

  it('follows new steps at the bottom of the thread unless the reader scrolled up', () => {
    const running = (count: number): ActivityCall => ({
      ...researchRun,
      status: 'running',
      events: Array.from({ length: count }, (_, index) => ({
        id: `thinking-${index}`, kind: 'thinking', label: `Step ${index}`, status: 'complete', timestamp: index,
      })),
    })
    const { rerender } = render(<ActivitySidebar calls={[running(1)]} onClear={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: 'Open /research tauri' }))
    const thread = screen.getByLabelText('Steps for /research tauri')
    let scrollHeight = 500
    let scrollTop = 0
    Object.defineProperties(thread, {
      scrollHeight: { configurable: true, get: () => scrollHeight },
      clientHeight: { configurable: true, get: () => 200 },
      scrollTop: { configurable: true, get: () => scrollTop, set: (value: number) => { scrollTop = value } },
    })

    rerender(<ActivitySidebar calls={[running(2)]} onClear={() => undefined} />)
    expect(scrollTop).toBe(500)

    scrollTop = 100
    fireEvent.scroll(thread)
    scrollHeight = 700
    rerender(<ActivitySidebar calls={[running(3)]} onClear={() => undefined} />)
    expect(scrollTop).toBe(100)

    scrollTop = 500
    fireEvent.scroll(thread)
    scrollHeight = 900
    rerender(<ActivitySidebar calls={[running(4)]} onClear={() => undefined} />)
    expect(scrollTop).toBe(900)
  })

  it('offers explicit recovery for a retained unplaced result', () => {
    const onPlaceResult = vi.fn()
    render(<ActivitySidebar calls={[{
      id: 'run-unplaced', label: 'Run /label', status: 'complete', timestamp: 1,
      placementPending: true, events: [],
    }]} onClear={() => undefined} onPlaceResult={onPlaceResult} />)

    fireEvent.click(screen.getByRole('button', { name: 'Place here' }))
    expect(onPlaceResult).toHaveBeenCalledWith('run-unplaced')
  })

  it('offers stopping only for a registered running execution', () => {
    const onCancel = vi.fn()
    render(<ActivitySidebar calls={[
      { id: 'extension-run', kind: 'skill', label: 'Run /label', status: 'running', timestamp: 1, events: [] },
      { id: 'other-run', kind: 'skill', label: 'Run /research', status: 'running', timestamp: 2, events: [] },
    ]} onClear={() => undefined} onCancel={onCancel} canCancel={(runId) => runId === 'extension-run'} />)

    fireEvent.click(screen.getByRole('button', { name: 'Open /research' }))
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'All activity' }))

    fireEvent.click(screen.getByRole('button', { name: 'Open /label' }))
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(onCancel).toHaveBeenCalledWith('extension-run')
  })
})
