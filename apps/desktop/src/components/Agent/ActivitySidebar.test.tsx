import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
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
})
