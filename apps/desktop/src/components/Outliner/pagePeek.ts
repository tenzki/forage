// Trusted main owns leases; remote native pages never choose a label or resource.
import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
export interface PageBounds {
  x: number; y: number; width: number; height: number
  clipX: number; clipY: number; clipWidth: number; clipHeight: number
  viewportWidth: number; viewportHeight: number
}
export interface PageState { resourceId: string; paneId: string; generation: number; url: string; loading: boolean; title?: string | null }
export type PageAction = 'back' | 'forward' | 'reload'
export const pagePeekAvailable = () => isTauri()
export const focusApplication = (): Promise<void> => invoke('workspace_focus', { page: false })
const owners = new Map<string, string>()
export const pageResourceOwnedBy = (resourceId: string, paneId: string): boolean => owners.get(resourceId) === paneId
export function boundsOf(element: Element): PageBounds {
  const r = element.getBoundingClientRect(), root = document.documentElement
  const strip = element.closest('.workspace-panes')?.getBoundingClientRect()
  const x = Math.max(0, r.left, strip?.left ?? 0), y = Math.max(0, r.top, strip?.top ?? 0)
  const right = Math.min(root.clientWidth, r.right, strip?.right ?? root.clientWidth)
  const bottom = Math.min(root.clientHeight, r.bottom, strip?.bottom ?? root.clientHeight)
  return { x: r.left, y: r.top, width: Math.max(1, r.width), height: Math.max(1, r.height), clipX: x, clipY: y,
    clipWidth: Math.max(0, right - x), clipHeight: Math.max(0, bottom - y), viewportWidth: root.clientWidth, viewportHeight: root.clientHeight }
}

/** Lifetime owns creation, commands, addressed events and late async cleanup. */
export class PageLease {
  private disposed = false
  private generation = 0
  private sequence = 0
  private stop?: () => void
  private id?: string
  private readonly ready: Promise<string>
  constructor(readonly paneId: string, onState: (state: PageState) => void) {
    // Register first so even the initial navigation is observed.
    this.ready = Promise.resolve().then(async () => {
      const stop = await listen<PageState>('page-peek:state', event => {
        const s = event.payload
        if (!this.disposed && s.resourceId === this.id && owners.get(s.resourceId) === paneId && s.generation === this.generation) onState(s)
      })
      if (this.disposed) { stop(); throw new Error('Page pane closed') }
      this.stop = stop
      const id = await invoke<string>('page_peek_create', { paneId })
      if (this.disposed) { await invoke('page_peek_close', { resourceId: id }); throw new Error('Page pane closed') }
      this.id = id; owners.set(id, paneId); return id
    })
    // Creation errors are handled by the owning pane; never leave an unhandled promise.
    void this.ready.catch(() => { this.stop?.(); this.stop = undefined })
  }
  private async command<T>(name: string, args: object = {}): Promise<T> {
    const id = await this.ready
    if (this.disposed) throw new Error('Page pane closed')
    return invoke<T>(name, { resourceId: id, ...args })
  }
  suspend(): void { this.generation++ }
  load(url: string): Promise<void> { return this.command('page_peek_load', { url, generation: ++this.generation }) }
  present(bounds: PageBounds, visible: boolean): Promise<void> { return this.command('page_peek_present', { bounds, visible, sequence: ++this.sequence }) }
  navigate(action: PageAction): Promise<void> { return this.command('page_peek_navigate', { action }) }
  focus(): Promise<void> { return this.command('workspace_focus', { page: true }) }
  async snapshot(): Promise<string | null> {
    const generation = this.generation
    const bytes = await this.command<ArrayBuffer>('page_peek_snapshot')
    if (this.disposed || generation !== this.generation) return null
    return URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }))
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true; this.stop?.(); this.stop = undefined
    if (this.id) owners.delete(this.id)
    void this.ready.then(id => { owners.delete(id); return invoke('page_peek_close', { resourceId: id }) }).catch(() => undefined)
  }
}

// One frame for all surfaces per invalidation, including scroll that changes only position.
const observers = new Set<() => void>()
let frame = 0
let mutation: MutationObserver | undefined
let resize: ResizeObserver | undefined
let transitionUntil = 0
export const PAGE_OVERLAYS = '[aria-modal="true"], [data-pane-menu="open"], [role="menu"], .formatting-bubble, .slash-menu, .internal-link-menu, .tag-menu, .link-card'
export function hasPageOverlay(): boolean {
  return [...document.querySelectorAll<HTMLElement>(PAGE_OVERLAYS)].some(element => {
    if (element.closest('[hidden], [aria-hidden="true"]')) return false
    const style = getComputedStyle(element)
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
  })
}
export function invalidatePageGeometry(): void {
  if (frame || !observers.size) return
  frame = requestAnimationFrame(() => {
    frame = 0; for (const update of observers) update()
    if (performance.now() < transitionUntil) invalidatePageGeometry()
  })
}
function transition(): void { transitionUntil = performance.now() + 800; invalidatePageGeometry() }
export function observePageGeometry(element: Element, update: () => void): () => void {
  observers.add(update)
  if (observers.size === 1) {
    window.addEventListener('resize', invalidatePageGeometry)
    document.addEventListener('scroll', invalidatePageGeometry, true)
    document.addEventListener('transitionrun', transition, true)
    mutation = new MutationObserver(invalidatePageGeometry)
    mutation.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class','style','hidden','aria-modal','data-pane-menu','open'] })
    resize = new ResizeObserver(invalidatePageGeometry)
    resize.observe(document.documentElement)
  }
  resize?.observe(element)
  const strip = element.closest('.workspace-panes'); if (strip) resize?.observe(strip)
  invalidatePageGeometry()
  return () => {
    observers.delete(update); resize?.unobserve(element)
    if (!observers.size) {
      cancelAnimationFrame(frame); frame = 0; transitionUntil = 0
      mutation?.disconnect(); resize?.disconnect()
      window.removeEventListener('resize', invalidatePageGeometry)
      document.removeEventListener('scroll', invalidatePageGeometry, true)
      document.removeEventListener('transitionrun', transition, true)
    }
  }
}
