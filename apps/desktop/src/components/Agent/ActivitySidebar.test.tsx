import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { ActivitySidebar, type ActivityCall } from './ActivitySidebar'

describe('activity sidebar', () => {
  it('shows observable agent phases and expandable details', () => {
    const calls: ActivityCall[] = [
      {
        id: 'skill-1',
        label: 'Run /research',
        detail: 'Research the current topic',
        status: 'complete',
        timestamp: 1,
        durationMs: 1200,
        events: [
          { id: 'thinking-1', kind: 'thinking', label: 'Thinking', status: 'complete', timestamp: 1 },
          { id: 'tool-1', kind: 'tool', label: 'web_search', detail: 'query: Tauri shell plugin', status: 'running', timestamp: 2 },
        ],
      },
    ]

    render(<ActivitySidebar calls={calls} onClear={() => undefined} />)

    expect(screen.getByRole('complementary', { name: 'Agent activity' })).toBeTruthy()
    expect(screen.getByText('Run /research')).toBeTruthy()
    expect(screen.getByText('web_search')).toBeTruthy()
    expect(screen.getByText('query: Tauri shell plugin')).toBeTruthy()
    expect(screen.getByText('1.2s')).toBeTruthy()
    expect(screen.getByRole('list', { name: 'Execution timeline for Run /research' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Clear activity' })).toBeTruthy()
  })

  it('shows an empty state when no activity has occurred', () => {
    render(<ActivitySidebar calls={[]} onClear={() => undefined} />)

    expect(screen.getByText('No activity yet')).toBeTruthy()
    expect(screen.getByText('Run a skill to see its work here.')).toBeTruthy()
  })

  it('opens the invocation bullet from the header and the result bullet from its event', () => {
    const onOpenNode = vi.fn()
    const calls: ActivityCall[] = [
      {
        id: 'run-1',
        label: 'Run /research tauri',
        status: 'complete',
        timestamp: 1,
        nodeId: 'bullet-1',
        events: [
          { id: 'result-run-1', kind: 'output', label: 'Open result', status: 'complete', timestamp: 2, nodeId: 'bullet-9' },
        ],
      },
    ]

    render(<ActivitySidebar calls={calls} onClear={() => undefined} onOpenNode={onOpenNode} />)

    fireEvent.click(screen.getByRole('button', { name: 'Open outline bullet for Run /research tauri' }))
    expect(onOpenNode).toHaveBeenCalledWith('bullet-1')

    fireEvent.click(screen.getByRole('button', { name: 'Open outline result for Open result' }))
    expect(onOpenNode).toHaveBeenLastCalledWith('bullet-9', 'bullet-1')

    expect(screen.getByRole('button', { name: 'Collapse execution for Run /research tauri' })).toBeTruthy()
  })
})
