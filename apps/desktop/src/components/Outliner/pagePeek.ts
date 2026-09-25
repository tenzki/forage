// Bridge to the link peek's embedded page (src-tauri/src/page_peek.rs): a native
// webview the Rust side lays over the peek pane's content rectangle. The app's
// CSP forbids framing remote origins, so an iframe is not an option.

import { invoke, isTauri } from '@tauri-apps/api/core'

/**
 * A rectangle in the main webview's CSS pixels, with that webview's viewport
 * size; the Rust side anchors it to the window from the viewport's bottom edge.
 */
export interface PageBounds {
  x: number
  y: number
  width: number
  height: number
  viewportWidth: number
  viewportHeight: number
}

export interface PageState {
  url: string
  loading: boolean
  title?: string | null
}

export type PageAction = 'back' | 'forward' | 'reload'

const STATE_EVENT = 'page-peek:state'

/** Live pages need the native shell; `dev:web` has nowhere to put one. */
export function pagePeekAvailable(): boolean {
  return isTauri()
}

export function boundsOf(element: Element): PageBounds {
  const rect = element.getBoundingClientRect()
  const root = document.documentElement
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
    viewportWidth: root.clientWidth,
    viewportHeight: root.clientHeight,
  }
}

/** Create the hidden page webview ahead of the first peek. */
export function preparePage(): Promise<void> {
  return invoke('page_peek_prepare')
}

/** Start loading `url` out of sight, while the pane is still sliding in. */
export function loadPage(url: string): Promise<void> {
  return invoke('page_peek_load', { url })
}

/** Lay the page over the pane and show it. */
export function showPage(bounds: PageBounds): Promise<void> {
  return invoke('page_peek_show', { bounds })
}

export function setPageBounds(bounds: PageBounds): Promise<void> {
  return invoke('page_peek_set_bounds', { bounds })
}

export function setPageVisible(visible: boolean): Promise<void> {
  return invoke('page_peek_set_visible', { visible })
}

export function navigatePage(action: PageAction): Promise<void> {
  return invoke('page_peek_navigate', { action })
}

export async function snapshotPage(): Promise<string> {
  const bytes = await invoke<ArrayBuffer>('page_peek_snapshot')
  return URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }))
}

/** Hide the page and blank it; the webview stays ready for the next peek. */
export function closePage(): Promise<void> {
  return invoke('page_peek_close')
}

export async function onPageState(handler: (state: PageState) => void): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event')
  return listen<PageState>(STATE_EVENT, (event) => handler(event.payload))
}
