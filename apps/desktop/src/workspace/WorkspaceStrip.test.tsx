import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { DocumentCoordinator } from '../editor/DocumentCoordinator'
import { EMPTY_DOC } from '../editor/emptyDoc'
import { WorkspaceController } from './WorkspaceController'
import {
  effectiveMinimum,
  revealPane,
  updateOutlineVisibility,
  widthAtTrailingEdge,
  WorkspaceStrip,
} from './WorkspaceStrip'
import { workspaceReducer, initialWorkspace } from './workspaceState'

describe('workspace shell geometry', () => {
  it('renders intersecting outline panes and restores offscreen ones when scrolled back', () => {
    const strip = document.createElement('div')
    const panes = Array.from({ length: 3 }, () =>
      strip.appendChild(document.createElement('section')),
    )
    panes.forEach((pane) => {
      pane.className = 'workspace-outline-pane'
    })
    strip.getBoundingClientRect = () => ({ left: 100, right: 820, width: 720 }) as DOMRect
    let offset = 0
    panes.forEach((pane, i) => {
      pane.getBoundingClientRect = () =>
        ({ left: 100 + i * 481 - offset, right: 580 + i * 481 - offset, width: 480 }) as DOMRect
    })
    updateOutlineVisibility(strip)
    expect(panes.map((pane) => pane.hasAttribute('data-offscreen'))).toEqual([false, false, true])
    offset = 500
    updateOutlineVisibility(strip)
    expect(panes.map((pane) => pane.hasAttribute('data-offscreen'))).toEqual([true, false, false])
    offset = 0
    updateOutlineVisibility(strip)
    expect(panes.map((pane) => pane.hasAttribute('data-offscreen'))).toEqual([false, false, true])
  })
  it('reveals the requested pane and leaves an already visible pane alone', () => {
    const strip = document.createElement('div')
    const pane = document.createElement('section')
    strip.getBoundingClientRect = () => ({ left: 100, right: 820, width: 720 }) as DOMRect
    pane.getBoundingClientRect = () => ({ left: 1062, right: 1542, width: 480 }) as DOMRect
    revealPane(strip, pane)
    expect(strip.scrollLeft).toBe(722)
    pane.getBoundingClientRect = () => ({ left: 100, right: 580, width: 480 }) as DOMRect
    revealPane(strip, pane)
    expect(strip.scrollLeft).toBe(722)
    pane.getBoundingClientRect = () => ({ left: 20, right: 500, width: 480 }) as DOMRect
    revealPane(strip, pane)
    expect(strip.scrollLeft).toBe(642)
    expect(effectiveMinimum(280)).toBe(280)
    expect(effectiveMinimum(1200)).toBe(360)
    expect(effectiveMinimum(280, 2)).toBe(360)
  })
  it('resizes adjacent panes with bounds without changing visits or the third pane', () => {
    let state = workspaceReducer(initialWorkspace(), {
      type: 'split',
      sourceId: 'primary',
      id: 'b',
    })
    state = workspaceReducer(state, { type: 'split', sourceId: 'b', id: 'c' })
    const visits = state.panes.map((pane) => pane.current)
    state = workspaceReducer(state, {
      type: 'resizePair',
      id: 'primary',
      delta: 1000,
      minimum: 360,
    })
    expect(state.panes.map((pane) => pane.width)).toEqual([600, 360, 480])
    state = workspaceReducer(state, {
      type: 'resizePair',
      id: 'primary',
      delta: -1000,
      minimum: 360,
    })
    expect(state.panes.map((pane) => pane.width)).toEqual([360, 600, 480])
    expect(state.panes.map((pane) => pane.current)).toEqual(visits)
  })
  it('exposes separator keyboard controls and never reveals on background scroll updates', () => {
    const documentCoordinator = new DocumentCoordinator(EMPTY_DOC, { onTransaction: vi.fn() })
    const workspace = new WorkspaceController(documentCoordinator)
    workspace.split('primary')
    const child = (id: string) => <section data-pane-id={id} />
    const view = render(
      <WorkspaceStrip workspace={workspace} state={workspace.getSnapshot()}>
        {child}
      </WorkspaceStrip>,
    )
    const separator = screen.getByRole('separator', { name: 'Resize adjacent panes' })
    fireEvent.keyDown(separator, { key: 'ArrowRight' })
    expect(workspace.getSnapshot().panes.map((pane) => pane.width)).toEqual([490, 470])
    const strip = view.container.firstChild as HTMLElement
    strip.scrollLeft = 95
    workspace.scroll('primary', 100)
    view.rerender(
      <WorkspaceStrip workspace={workspace} state={workspace.getSnapshot()}>
        {child}
      </WorkspaceStrip>,
    )
    expect(strip.scrollLeft).toBe(95)
    expect(separator.getAttribute('aria-valuenow')).toBe('490')
    view.unmount()
    documentCoordinator.destroy()
  })
  it('resizes only the last pane from the outer handle and removes it for a single pane', () => {
    const coordinator = new DocumentCoordinator(EMPTY_DOC, { onTransaction: vi.fn() })
    const workspace = new WorkspaceController(coordinator)
    workspace.split('primary')
    const original = workspace.getSnapshot()
    const child = (id: string) => (
      <section
        data-pane-id={id}
        ref={(element) => {
          // Retain the previous measured size until ResizeObserver runs again.
          if (element) element.getBoundingClientRect = () => ({ width: 480 }) as DOMRect
        }}
      />
    )
    const renderStrip = () => (
      <WorkspaceStrip workspace={workspace} state={workspace.getSnapshot()}>
        {child}
      </WorkspaceStrip>
    )
    const view = render(renderStrip())
    const separator = screen.getByRole('separator', { name: 'Resize last pane' })
    separator.focus()
    fireEvent.keyDown(separator, { key: 'ArrowRight', shiftKey: true })
    view.rerender(renderStrip())
    expect(workspace.getSnapshot().panes.map((pane) => pane.width)).toEqual([480, 530])
    expect(workspace.getSnapshot().activePaneId).toBe(original.activePaneId)
    expect(workspace.getSnapshot().panes.map((pane) => pane.current)).toEqual(
      original.panes.map((pane) => pane.current),
    )
    expect(document.activeElement).toBe(separator)
    expect(separator.getAttribute('aria-valuenow')).toBe('530')
    expect(separator.hasAttribute('aria-valuemax')).toBe(false)
    for (let i = 0; i < 5; i++) {
      fireEvent.keyDown(separator, { key: 'ArrowLeft', shiftKey: true })
      view.rerender(renderStrip())
    }
    expect(workspace.getSnapshot().panes.map((pane) => pane.width)).toEqual([480, 360])
    workspace.close(original.panes[1].id)
    view.rerender(renderStrip())
    expect(screen.queryByRole('separator')).toBeNull()
    view.unmount()
    coordinator.destroy()
  })
  it('keeps a dragged trailing edge under the pointer across centered and overflowing layouts', () => {
    // Other columns and both 1px rules occupy 482px.
    expect(widthAtTrailingEdge(1400, 482, 1181)).toBe(480)
    expect(widthAtTrailingEdge(1400, 482, 1221)).toBe(560)
    expect(widthAtTrailingEdge(1400, 482, 1400)).toBe(918)
    expect(widthAtTrailingEdge(1400, 482, 1420)).toBe(938)
    expect(widthAtTrailingEdge(700, 482, 962)).toBe(480)
    expect(widthAtTrailingEdge(700, 482, 500)).toBe(360)
  })
})
