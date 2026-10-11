import { Fragment, useLayoutEffect, useRef, useState } from 'react'
import type { WorkspaceController } from './WorkspaceController'
import type { WorkspaceState } from './workspaceState'

export const effectiveMinimum = (viewport: number, paneCount = 1) =>
  paneCount > 1 ? 360 : Math.min(360, Math.max(1, viewport))
/** In a centered group both margins change as the last pane grows. Once the
 * group fills the viewport its leading edge stays at the scroll origin. */
export const widthAtTrailingEdge = (viewport: number, otherWidth: number, edge: number) =>
  Math.max(360, (edge <= viewport ? 2 * edge - viewport : edge) - otherWidth)
/** WebKit's automatic content visibility can skip an intersecting column after
 * insertion/native Page focus. Cull only columns wholly outside the strip. */
export function updateOutlineVisibility(strip: HTMLElement): void {
  const viewport = strip.getBoundingClientRect()
  for (const pane of strip.querySelectorAll<HTMLElement>(':scope > .workspace-outline-pane')) {
    const rect = pane.getBoundingClientRect()
    pane.toggleAttribute(
      'data-offscreen',
      viewport.width > 0 && (rect.right <= viewport.left || rect.left >= viewport.right),
    )
  }
}
/** Reveal only on explicit activation/insertion, never on document or scroll updates. */
export function revealPane(strip: HTMLElement, pane: HTMLElement): void {
  const viewport = strip.getBoundingClientRect()
  const rect = pane.getBoundingClientRect()
  if (rect.left < viewport.left) strip.scrollLeft += rect.left - viewport.left
  else if (rect.right > viewport.right)
    strip.scrollLeft +=
      rect.width > viewport.width ? rect.left - viewport.left : rect.right - viewport.right
  updateOutlineVisibility(strip)
}
export function WorkspaceStrip({
  workspace,
  state,
  children,
}: {
  workspace: WorkspaceController | null
  state: WorkspaceState
  children: (id: string) => React.ReactNode
}) {
  const strip = useRef<HTMLDivElement>(null)
  const [minimum, setMinimum] = useState(360)
  const [widths, setWidths] = useState<Record<string, number>>({})
  useLayoutEffect(() => {
    if (!strip.current) return
    const measure = () => {
      setMinimum(effectiveMinimum(strip.current!.clientWidth || 360, state.panes.length))
      const next: Record<string, number> = {}
      for (const pane of strip.current!.querySelectorAll<HTMLElement>(':scope > [data-pane-id]')) {
        const width = pane.getBoundingClientRect().width
        if (width) next[pane.dataset.paneId!] = width
      }
      setWidths((previous) => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next))
      updateOutlineVisibility(strip.current!)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(strip.current)
    for (const pane of strip.current.querySelectorAll(':scope > [data-pane-id]'))
      observer.observe(pane)
    return () => observer.disconnect()
  }, [state.panes.map((pane) => pane.id).join(',')])
  useLayoutEffect(
    () =>
      workspace?.onReveal((id) => {
        const root = strip.current
        const pane = [
          ...(root?.querySelectorAll<HTMLElement>(':scope > [data-pane-id]') ?? []),
        ].find((element) => element.dataset.paneId === id)
        if (root && pane) revealPane(root, pane)
      }),
    [workspace],
  )
  useLayoutEffect(() => {
    const root = strip.current
    const pane = [...(root?.querySelectorAll<HTMLElement>(':scope > [data-pane-id]') ?? [])].find(
      (element) => element.dataset.paneId === state.activePaneId,
    )
    if (root && pane) {
      revealPane(root, pane)
      if (pane.classList.contains('workspace-web-pane')) pane.focus({ preventScroll: true })
    }
  }, [state.activePaneId])
  return (
    <div
      className="workspace-panes"
      ref={strip}
      onScroll={(event) => updateOutlineVisibility(event.currentTarget)}
    >
      {state.panes.map((pane, index) => {
        const next = state.panes[index + 1]
        const width = next ? (widths[pane.id] ?? pane.width) : pane.width
        const resizeBy = (delta: number) => {
          if (next) workspace?.resizePair(pane.id, delta, minimum, widths[pane.id], widths[next.id])
          else workspace?.resize(pane.id, width + delta)
        }
        return (
          <Fragment key={pane.id}>
            {children(pane.id)}
            {state.panes.length > 1 && workspace && (
              <div
                className="pane-separator"
                role="separator"
                aria-label={next ? 'Resize adjacent panes' : 'Resize last pane'}
                aria-orientation="vertical"
                tabIndex={0}
                aria-valuemin={minimum}
                aria-valuemax={next ? width + (widths[next.id] ?? next.width) - minimum : undefined}
                aria-valuenow={width}
                aria-valuetext={`${Math.round(width)} pixels`}
                onKeyDown={(event) => {
                  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                  event.preventDefault()
                  resizeBy((event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 50 : 10))
                }}
                onPointerDown={(event) => {
                  event.preventDefault()
                  event.currentTarget.setPointerCapture(event.pointerId)
                  event.currentTarget.dataset.resizeX = String(event.clientX)
                  event.currentTarget.dataset.edgeOffset = String(
                    event.clientX - event.currentTarget.getBoundingClientRect().right,
                  )
                }}
                onPointerMove={(event) => {
                  if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
                  if (next) resizeBy(event.clientX - Number(event.currentTarget.dataset.resizeX))
                  else {
                    const root = strip.current!
                    const first = root.querySelector<HTMLElement>(':scope > [data-pane-id]')!
                    const last = event.currentTarget.previousElementSibling!
                    const otherWidth =
                      event.currentTarget.getBoundingClientRect().right -
                      first.getBoundingClientRect().left -
                      last.getBoundingClientRect().width
                    const edge =
                      event.clientX -
                      Number(event.currentTarget.dataset.edgeOffset) -
                      root.getBoundingClientRect().left +
                      root.scrollLeft
                    workspace.resize(
                      pane.id,
                      widthAtTrailingEdge(root.clientWidth, otherWidth, edge),
                    )
                  }
                  event.currentTarget.dataset.resizeX = String(event.clientX)
                }}
                onPointerUp={(event) => {
                  if (event.currentTarget.hasPointerCapture(event.pointerId))
                    event.currentTarget.releasePointerCapture(event.pointerId)
                }}
              />
            )}
          </Fragment>
        )
      })}
    </div>
  )
}
