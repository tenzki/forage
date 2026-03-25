import { describe, it, expect, vi } from 'vitest'
import { render } from '@testing-library/react'
import Bullet from './Bullet'
import type { TreeNode } from '../../types/tree'

// Mock treeStore to avoid Tauri window API calls
vi.mock('../../store/treeStore', () => ({
  useTreeStore: (selector: (s: { toggleNode: () => void; zoomIn: () => void }) => unknown) =>
    selector({ toggleNode: vi.fn(), zoomIn: vi.fn() }),
}))

function makeNode(overrides: Partial<TreeNode> = {}): TreeNode {
  return {
    id: 'test-node',
    name: 'Test node',
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
    position: 'a0',
    collapsed: false,
    parent_id: null,
    node_type: 'note',
    children: [],
    ...overrides,
  }
}

describe('Bullet', () => {
  it('renders .bullet-dot for a regular note node', () => {
    const node = makeNode({ node_type: 'note' })
    const { container } = render(<Bullet node={node} />)

    const dot = container.querySelector('.bullet-dot')
    expect(dot).toBeTruthy()

    const ai = container.querySelector('.bullet-ai')
    expect(ai).toBeNull()
  })

  it('renders .bullet-ai with sparkle SVG for agent_response nodes', () => {
    const node = makeNode({ node_type: 'agent_response' })
    const { container } = render(<Bullet node={node} />)

    const ai = container.querySelector('.bullet-ai')
    expect(ai).toBeTruthy()

    // Should contain an SVG sparkle icon
    const svg = ai?.querySelector('svg')
    expect(svg).toBeTruthy()

    // Regular dot should NOT be rendered
    const dot = container.querySelector('.bullet-dot')
    expect(dot).toBeNull()
  })

  it('renders the expand/collapse triangle for all node types', () => {
    const noteNode = makeNode({ node_type: 'note' })
    const { container: noteContainer } = render(<Bullet node={noteNode} />)
    expect(noteContainer.querySelector('.bullet-toggle')).toBeTruthy()

    const aiNode = makeNode({ node_type: 'agent_response' })
    const { container: aiContainer } = render(<Bullet node={aiNode} />)
    expect(aiContainer.querySelector('.bullet-toggle')).toBeTruthy()
  })

  it('hides the toggle triangle when node has no children and is not collapsed', () => {
    const node = makeNode({ node_type: 'note', children: [], collapsed: false })
    const { container } = render(<Bullet node={node} />)

    const toggle = container.querySelector('.bullet-toggle')
    expect(toggle?.classList.contains('bullet-toggle--hidden')).toBe(true)
  })

  it('shows the toggle triangle when node has children', () => {
    const child = makeNode({ id: 'child' })
    const node = makeNode({ node_type: 'note', children: [child], collapsed: false })
    const { container } = render(<Bullet node={node} />)

    const toggle = container.querySelector('.bullet-toggle')
    expect(toggle?.classList.contains('bullet-toggle--hidden')).toBe(false)
  })

  it('shows the toggle triangle when node is collapsed even without loaded children', () => {
    const node = makeNode({ node_type: 'note', children: [], collapsed: true })
    const { container } = render(<Bullet node={node} />)

    const toggle = container.querySelector('.bullet-toggle')
    expect(toggle?.classList.contains('bullet-toggle--hidden')).toBe(false)
  })
})
