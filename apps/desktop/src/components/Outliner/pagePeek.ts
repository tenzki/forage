// Bridge to the link peek's embedded page (src-tauri/src/page_peek.rs): a native
// webview the Rust side lays over the peek pane's content rectangle. The app's
// CSP forbids framing remote origins, so an iframe is not an option.

import { invoke, isTauri } from '@tauri-apps/api/core'

/** Logical pixels relative to the window's content area. */
export interface PageBounds {
  x: number
  y: number
  width: number
  height: number
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
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height }
}

export function openPage(url: string, bounds: PageBounds): Promise<void> {
  return invoke('page_peek_open', { url, bounds })
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

export function closePage(): Promise<void> {
  return invoke('page_peek_close')
}

export async function onPageState(handler: (state: PageState) => void): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event')
  return listen<PageState>(STATE_EVENT, (event) => handler(event.payload))
}
