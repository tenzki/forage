// The peek's header bar, running as its own borderless window.
//
// It used to be painted into the outline directly above the peek window's
// rectangle. That meant mapping the main webview's client coordinates onto
// screen coordinates, and no reliable source for that mapping exists here:
// `innerPosition()` disagreed with where the webview viewport actually sits, so
// the always-on-top peek kept landing over the header — hiding its contents and
// swallowing clicks meant for its buttons.
//
// Two windows share one coordinate space, so a header window can be pinned to
// the peek's measured rectangle exactly, with no mapping in between. It also
// gets its own webview, so its buttons receive their own clicks.
//
// This page runs the app bundle under a hash route (see main.tsx) and is granted
// its own narrow capability — `opener` and window close, nothing else.

import { useEffect, useState } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'

const PEEK_LABEL = 'link-peek'

export const PEEK_HEADER_LABEL = 'link-peek-header'
export const PEEK_HEADER_ROUTE = '#peek-header'

/** Height of the header window, in logical pixels. */
export const PEEK_HEADER_HEIGHT = 40

export function peekHeaderUrl(href: string): string {
  return `index.html${PEEK_HEADER_ROUTE}?url=${encodeURIComponent(href)}`
}

/** The peeked URL when this document is the header window, else null. */
export function peekHeaderHref(hash: string): string | null {
  if (!hash.startsWith(PEEK_HEADER_ROUTE)) return null
  const marker = hash.indexOf('?')
  if (marker === -1) return null
  return new URLSearchParams(hash.slice(marker + 1)).get('url')
}

export function splitUrl(href: string): { host: string; rest: string } {
  try {
    const url = new URL(href)
    const rest = `${url.pathname}${url.search}`.replace(/^\/$/u, '')
    return { host: url.hostname.replace(/^www\./u, ''), rest }
  } catch {
    return { host: href, rest: '' }
  }
}

/** Take the whole peek down: the page window first, then this one. */
async function closePeek(): Promise<void> {
  const [{ WebviewWindow }, { getCurrentWindow }] = await Promise.all([
    import('@tauri-apps/api/webviewWindow'),
    import('@tauri-apps/api/window'),
  ])
  const page = await WebviewWindow.getByLabel(PEEK_LABEL)
  await page?.close().catch(() => undefined)
  await getCurrentWindow().close().catch(() => undefined)
}

const COPIED_FEEDBACK_MS = 1400

async function copyToClipboard(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return
    }
  } catch {
    // Fall through to the carrier below.
  }
  const carrier = document.createElement('textarea')
  carrier.value = text
  carrier.setAttribute('readonly', '')
  carrier.style.position = 'fixed'
  carrier.style.opacity = '0'
  document.body.appendChild(carrier)
  carrier.select()
  try {
    if (!document.execCommand('copy')) throw new Error('clipboard refused the copy')
  } finally {
    carrier.remove()
  }
}

const URL_POLL_MS = 400

function usePeekUrl(opened: string): string {
  const [href, setHref] = useState(opened)

  useEffect(() => {
    let stopped = false
    let timer: number | undefined

    void (async () => {
      const { invoke } = await import('@tauri-apps/api/core')
      while (!stopped) {
        try {
          const current = await invoke<string | null>('peek_page_url')
          if (current) setHref((previous) => (previous === current ? previous : current))
        } catch {
          // Not in Tauri, or the peek is gone: keep showing what we have.
          return
        }
        await new Promise((resolve) => {
          timer = window.setTimeout(resolve, URL_POLL_MS)
        })
      }
    })().catch(() => undefined)

    return () => {
      stopped = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [])

  return href
}

const HOVER_POLL_MS = 80

function useCursorHover(): void {
  useEffect(() => {
    let stopped = false
    let timer: number | undefined
    let hovered: Element | null = null

    const mark = (next: Element | null) => {
      if (next === hovered) return
      hovered?.classList.remove('is-hover')
      next?.classList.add('is-hover')
      hovered = next
    }

    void (async () => {
      const { cursorPosition, getCurrentWindow } = await import('@tauri-apps/api/window')
      const self = getCurrentWindow()
      while (!stopped) {
        try {
          const [cursor, origin, scale] = await Promise.all([
            cursorPosition(),
            self.outerPosition(),
            self.scaleFactor(),
          ])
          const x = (cursor.x - origin.x) / scale
          const y = (cursor.y - origin.y) / scale
          const inside = x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight
          mark(inside ? document.elementFromPoint(x, y)?.closest('button') ?? null : null)
        } catch {
          // Not in Tauri, or the window is going away: no hover to report.
          mark(null)
          return
        }
        await new Promise((resolve) => {
          timer = window.setTimeout(resolve, HOVER_POLL_MS)
        })
      }
    })().catch(() => undefined)

    return () => {
      stopped = true
      if (timer !== undefined) window.clearTimeout(timer)
      mark(null)
    }
  }, [])
}

export function PeekHeaderWindow({ href: opened }: { href: string }) {
  const href = usePeekUrl(opened)
  const [copied, setCopied] = useState(false)
  useCursorHover()

  useEffect(() => {
    if (!copied) return undefined
    const timer = window.setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS)
    return () => window.clearTimeout(timer)
  }, [copied])

  useEffect(() => {
    document.body.classList.add('link-peek-body')
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') void closePeek().catch(() => undefined)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const { host, rest } = splitUrl(href)
  return (
    <div className="link-peek-header is-window">
      <span className="link-peek-url" title={href}>
        <span className="link-peek-host">{host}</span>
        <span className="link-peek-path">{rest}</span>
      </span>
      <button
        type="button"
        className="link-peek-action"
        aria-label="Copy link"
        onClick={() => {
          void copyToClipboard(href)
            .then(() => setCopied(true))
            .catch(() => undefined)
        }}
      >
        {copied ? 'Copied ✓' : 'Copy link'}
      </button>
      <button
        type="button"
        className="link-peek-action"
        onClick={() => {
          void openUrl(href).catch(() => undefined)
          void closePeek().catch(() => undefined)
        }}
      >
        Open in browser ↗
      </button>
      <button
        type="button"
        className="link-peek-close"
        aria-label="Close preview"
        onClick={() => void closePeek().catch(() => undefined)}
      >
        ✕
      </button>
    </div>
  )
}
