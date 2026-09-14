// Arc-style page peek: a borderless child window floating over the outline, with
// a second borderless window pinned directly above it as its header bar.
//
// The app's CSP (`default-src 'self'`, no `frame-src`) makes an in-page iframe of
// a remote origin impossible, so the peek page has to be a real Tauri webview.
// Tauri's stable API puts exactly one webview in a window, so we cannot paint
// chrome on top of the remote page either.
//
// The header was first drawn by the main window above the peek's rectangle. That
// needs the main webview's client coordinates expressed in screen coordinates,
// and nothing here reports that mapping reliably — the peek kept landing over
// the header. A second window sidesteps it: both windows are placed and measured
// with the same API, in the same space, so pinning one to the other is exact.
//
// The peek page window deliberately carries no capability of its own: the
// default capability is scoped to `"windows": ["main"]`, so the remote page has
// no IPC access to the app. The header window is our own page and gets a
// separate, narrow capability.

import { useCallback, useEffect } from 'react'
import { isTauri } from '@tauri-apps/api/core'
import { OUTLINE_LINK_PEEK_EVENT, openExternally } from '../../editor/externalLinks'
import { normalizedUrl } from './FormattingBubbleMenu'
import { PEEK_HEADER_HEIGHT, PEEK_HEADER_LABEL, peekHeaderUrl } from './PeekHeaderWindow'

const PEEK_LABEL = 'link-peek'
/** Fraction of the main window the peek covers, then centred over it. */
const PEEK_SCALE = 0.9
const PEEK_MIN_WIDTH = 480
const PEEK_MIN_HEIGHT = 360
/** Ignore blur this soon after opening; focus churn would close it instantly. */
const BLUR_SETTLE_MS = 400
/** Blur fires before a click lands, so let focus settle before acting on it. */
const BLUR_GRACE_MS = 150
/** How long the app waits for the peek to close before quitting regardless. */
const CLOSE_CLEANUP_MS = 700

interface Rect { left: number; top: number; width: number; height: number }

type PeekWindow = InstanceType<typeof import('@tauri-apps/api/webviewWindow').WebviewWindow>

interface PeekApi {
  WebviewWindow: typeof import('@tauri-apps/api/webviewWindow').WebviewWindow
  getCurrentWindow: typeof import('@tauri-apps/api/window').getCurrentWindow
  LogicalPosition: typeof import('@tauri-apps/api/window').LogicalPosition
  LogicalSize: typeof import('@tauri-apps/api/window').LogicalSize
}

async function loadPeekApi(): Promise<PeekApi | null> {
  // The modules import fine in a plain browser or under jsdom — they only fail
  // once a command is invoked — so gate on the IPC bridge actually being there.
  if (!isTauri()) return null
  try {
    const [{ WebviewWindow }, { getCurrentWindow, LogicalPosition, LogicalSize }] =
      await Promise.all([
        import('@tauri-apps/api/webviewWindow'),
        import('@tauri-apps/api/window'),
      ])
    return { WebviewWindow, getCurrentWindow, LogicalPosition, LogicalSize }
  } catch {
    return null
  }
}

/**
 * Where to put the peek page, in screen coordinates: 90% of the main window,
 * centred on it, with room left above for the header window.
 *
 * Only the page window is placed from this. The header is placed against the
 * page's *measured* rectangle afterwards, so an imprecise origin here shifts the
 * whole peek a little but can never split it apart.
 */
async function peekGeometry(api: PeekApi): Promise<Rect> {
  const host = api.getCurrentWindow()
  const [scale, outer, outerSize, innerSize] = await Promise.all([
    host.scaleFactor(),
    host.outerPosition(),
    host.outerSize(),
    host.innerSize(),
  ])
  const frame = outer.toLogical(scale)
  const shell = outerSize.toLogical(scale)
  const view = innerSize.toLogical(scale)
  const width = Math.max(PEEK_MIN_WIDTH, Math.round(view.width * PEEK_SCALE))
  const height = Math.max(PEEK_MIN_HEIGHT, Math.round(view.height * PEEK_SCALE) - PEEK_HEADER_HEIGHT)
  return {
    left: Math.round(frame.x + (shell.width - width) / 2),
    top: Math.round(frame.y + (shell.height - height) / 2 + PEEK_HEADER_HEIGHT / 2),
    width,
    height,
  }
}

/**
 * The JS webview API has no `navigate`, so showing a second link means closing
 * the first window and recreating it. Labels stay registered for a moment after
 * `close()` resolves, so wait for the label to actually free up before reusing it.
 */
async function releaseLabel(api: PeekApi, label: string): Promise<void> {
  const existing = await api.WebviewWindow.getByLabel(label)
  if (!existing) return
  await existing.close()
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (!(await api.WebviewWindow.getByLabel(label))) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

async function closePeekWindows(): Promise<void> {
  const api = await loadPeekApi()
  if (!api) return
  for (const label of [PEEK_HEADER_LABEL, PEEK_LABEL]) {
    const existing = await api.WebviewWindow.getByLabel(label)
    await existing?.close().catch(() => undefined)
  }
}

/** The page window's actual rectangle, once the OS has laid it out. */
async function measure(peek: PeekWindow): Promise<Rect | null> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const [scale, position, size] = await Promise.all([
        peek.scaleFactor(),
        peek.outerPosition(),
        peek.outerSize(),
      ])
      const at = position.toLogical(scale)
      const extent = size.toLogical(scale)
      if (extent.width < 1) throw new Error('window not laid out yet')
      return { left: at.x, top: at.y, width: extent.width, height: extent.height }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
  }
  return null
}

/**
 * Pin the header window flush on top of the page window. Both rectangles come
 * from the same API in the same coordinate space, so this is exact — there is no
 * client-to-screen conversion anywhere in it.
 */
async function openHeader(api: PeekApi, href: string, page: Rect): Promise<void> {
  await releaseLabel(api, PEEK_HEADER_LABEL)
  const header = new api.WebviewWindow(PEEK_HEADER_LABEL, {
    url: peekHeaderUrl(href),
    decorations: false,
    alwaysOnTop: true,
    // Leave focus on the page; taking it would blur the peek the moment it opens.
    focus: false,
    resizable: false,
    skipTaskbar: true,
    title: href,
    acceptFirstMouse: true,
    parent: api.getCurrentWindow(),
    x: Math.round(page.left),
    y: Math.round(page.top - PEEK_HEADER_HEIGHT),
    width: Math.round(page.width),
    height: PEEK_HEADER_HEIGHT,
  })
  void header.once('tauri://error', () => undefined).catch(() => undefined)
  // Closing the header (its ✕, or the OS) closes the peek with it.
  void header.once('tauri://destroyed', () => {
    void closePeekWindows().catch(() => undefined)
  }).catch(() => undefined)
}

/**
 * Keep the header pinned to the page window as that window moves and resizes,
 * so the two halves of the peek never come apart.
 *
 * `tauri://move` fires on every frame of a drag, so the placements are
 * coalesced: one in flight at a time, with at most one more queued behind it.
 * Both rectangles still come from the same API in the same coordinate space —
 * this tracks the page window, it does not re-derive where anything is.
 */
function followPage(api: PeekApi, peek: PeekWindow): () => void {
  let placing = false
  let queued = false

  const place = async (): Promise<void> => {
    if (placing) {
      queued = true
      return
    }
    placing = true
    try {
      do {
        queued = false
        const header = await api.WebviewWindow.getByLabel(PEEK_HEADER_LABEL)
        if (!header) return
        const page = await measure(peek)
        if (!page) return
        await header.setPosition(
          new api.LogicalPosition(page.left, page.top - PEEK_HEADER_HEIGHT),
        )
        await header.setSize(new api.LogicalSize(page.width, PEEK_HEADER_HEIGHT))
      } while (queued)
    } finally {
      placing = false
    }
  }

  const unlisteners: Array<() => void> = []
  let stopped = false
  for (const event of ['tauri://move', 'tauri://resize']) {
    void peek
      .listen(event, () => {
        void place().catch(() => undefined)
      })
      .then((unlisten) => (stopped ? unlisten() : unlisteners.push(unlisten)))
      .catch(() => undefined)
  }
  return () => {
    stopped = true
    unlisteners.splice(0).forEach((unlisten) => unlisten())
  }
}

function launchPeek(href: string, api: PeekApi, geometry: Rect, onDismissed: () => void): void {
  const peek = new api.WebviewWindow(PEEK_LABEL, {
    url: href,
    decorations: false,
    alwaysOnTop: true,
    focus: true,
    title: href,
    acceptFirstMouse: true,
    // Parented to the main window, so the OS keeps the peek attached to the app:
    // it rides along when the app moves, and it dies with the app rather than
    // being left behind as an orphan window after the outline closes.
    parent: api.getCurrentWindow(),
    x: geometry.left,
    y: geometry.top,
    width: geometry.width,
    height: geometry.height,
  })

  const stopFollowing = followPage(api, peek)

  void peek.once('tauri://error', () => {
    // Creating the window failed (missing permission, rejected URL); do not
    // strand the click — hand it to the real browser instead.
    stopFollowing()
    onDismissed()
    openExternally(href)
  }).catch(() => undefined)

  void peek.once('tauri://destroyed', () => {
    stopFollowing()
    onDismissed()
    void closePeekWindows().catch(() => undefined)
  }).catch(() => undefined)

  void measure(peek)
    .then((page) => (page ? openHeader(api, href, page) : undefined))
    .catch(() => undefined)

  // Click-away closes the peek. The window takes focus as it opens, and the
  // surrounding focus churn can emit a spurious blur, so ignore the first beat;
  // clicking our own header also blurs it, so confirm the header did not take
  // the focus before acting.
  const openedAt = Date.now()
  void peek.listen('tauri://blur', () => {
    if (Date.now() - openedAt < BLUR_SETTLE_MS) return
    setTimeout(() => {
      void (async () => {
        const header = await api.WebviewWindow.getByLabel(PEEK_HEADER_LABEL)
        if (await header?.isFocused().catch(() => false)) return
        await closePeekWindows().catch(() => undefined)
      })().catch(() => undefined)
    }, BLUR_GRACE_MS)
    // Losing blur-close is survivable; the header's ✕ and Escape still work.
  }).catch(() => undefined)
}

/**
 * Listen for peek requests from links and hover cards, and drive the pair of
 * windows that make up the peek. Renders nothing: the header is a window of its
 * own, not part of the outline's tree.
 */
export function useLinkPeek(): void {
  const close = useCallback(() => {
    void closePeekWindows().catch(() => undefined)
  }, [])

  useEffect(() => {
    let closed = false
    const onPeek = (event: Event) => {
      const href = (event as CustomEvent<{ href?: string }>).detail?.href
      if (!href) return
      let validated: string
      try {
        validated = normalizedUrl(href)
      } catch {
        return
      }
      void loadPeekApi()
        .then(async (api) => {
          if (closed) return
          if (!api) {
            // Browser-only `dev:web`: no Tauri windows to peek with.
            openExternally(validated)
            return
          }
          // One peek at a time, so a second link replaces the overlay rather
          // than stacking another one on top of it.
          await releaseLabel(api, PEEK_HEADER_LABEL)
          await releaseLabel(api, PEEK_LABEL)
          if (closed) return
          const geometry = await peekGeometry(api)
          launchPeek(validated, api, geometry, () => undefined)
        })
        .catch(() => {
          close()
          openExternally(validated)
        })
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }

    // Belt and braces on top of `parent`: if the app is asked to close while a
    // peek is open, take the peek with it rather than leaving a stray window.
    let unlistenClose: (() => void) | null = null
    void loadPeekApi()
      .then((api) => api?.getCurrentWindow().onCloseRequested(async () => {
        // Awaited, not fired and forgotten: Tauri destroys the main window as
        // soon as this handler resolves, and the webview — along with any
        // promise still running in it — dies with it. Closing the peek windows
        // afterwards would never happen, leaving them open and the app alive
        // with no way back to it. Capped, so a wedged close cannot trap the app.
        await Promise.race([
          closePeekWindows(),
          new Promise((resolve) => setTimeout(resolve, CLOSE_CLEANUP_MS)),
        ]).catch(() => undefined)
      }))
      .then((unlisten) => {
        if (!unlisten) return
        if (closed) unlisten()
        else unlistenClose = unlisten
      })
      .catch(() => undefined)

    window.addEventListener(OUTLINE_LINK_PEEK_EVENT, onPeek)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      closed = true
      window.removeEventListener(OUTLINE_LINK_PEEK_EVENT, onPeek)
      window.removeEventListener('keydown', onKeyDown)
      unlistenClose?.()
      void closePeekWindows().catch(() => undefined)
    }
  }, [close])
}
