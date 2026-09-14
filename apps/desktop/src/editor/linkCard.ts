// Hover unfurl cards.
//
// Hovering an external link pops a small card anchored under it with the page
// title and lead text. The card is a plain body-attached element rather than a
// ProseMirror decoration, so it never enters the document, the undo history, or
// the durable event stream, and it costs the editor no redecoration passes.

import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { ensurePreview, readPreview, type LinkPreview } from './linkPreview'
import { openExternally, requestLinkPeek } from './externalLinks'

const linkCardPluginKey = new PluginKey('outlineLinkCards')

/** Long enough that skimming a paragraph of links pops nothing. */
const HOVER_DELAY_MS = 320
/** Short grace period so the pointer can travel from link to card. */
const LEAVE_DELAY_MS = 180
const CARD_WIDTH = 320
const CARD_GAP = 8
const VIEWPORT_MARGIN = 12

interface Anchored {
  href: string
  anchor: HTMLElement
}

let card: HTMLElement | null = null
let shown: Anchored | null = null
let showTimer: ReturnType<typeof setTimeout> | null = null
let hideTimer: ReturnType<typeof setTimeout> | null = null

/** The external href of an anchor, or null for internal links and non-links. */
export function externalAnchorHref(target: EventTarget | null): { anchor: HTMLElement; href: string } | null {
  const anchor = target instanceof Element ? target.closest<HTMLAnchorElement>('a[href]') : null
  if (!anchor || anchor.dataset.internalNodeId) return null
  const href = anchor.getAttribute('href') ?? ''
  if (!/^https?:\/\//iu.test(href)) return null
  return { anchor, href }
}

function line(className: string, text: string): HTMLElement {
  const element = document.createElement('span')
  element.className = className
  element.textContent = text
  return element
}

function renderBody(href: string, preview: LinkPreview): void {
  if (!card) return
  card.className = `link-card is-${preview.status}`
  card.title = href
  card.replaceChildren()

  // No remote images: the app CSP allows only 'self', blob: and asset: sources,
  // so the card identifies the site with a monogram instead of a favicon.
  card.append(line('link-card-monogram', preview.host.slice(0, 1).toUpperCase()))

  const body = document.createElement('span')
  body.className = 'link-card-body'
  body.append(line('link-card-title', preview.title ?? (
    preview.status === 'error' ? preview.host : 'Loading preview…'
  )))
  if (preview.description) body.append(line('link-card-description', preview.description))
  body.append(line('link-card-host', preview.host))
  card.append(body)

  const external = document.createElement('button')
  external.type = 'button'
  external.className = 'link-card-external'
  external.title = 'Open in browser'
  external.setAttribute('aria-label', `Open ${preview.host} in browser`)
  external.textContent = '↗'
  external.addEventListener('mousedown', (event) => event.preventDefault())
  external.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    hideCard()
    openExternally(href)
  })
  card.append(external)
}

/** Sit under the link, flipping above it and clamping when the viewport is tight. */
function position(anchor: HTMLElement): void {
  if (!card) return
  const rect = anchor.getBoundingClientRect()
  const height = card.offsetHeight || 0
  const left = Math.min(
    Math.max(VIEWPORT_MARGIN, rect.left),
    Math.max(VIEWPORT_MARGIN, window.innerWidth - CARD_WIDTH - VIEWPORT_MARGIN),
  )
  const below = rect.bottom + CARD_GAP
  const flip = below + height > window.innerHeight - VIEWPORT_MARGIN && rect.top - CARD_GAP - height > 0
  card.style.left = `${Math.round(left)}px`
  card.style.top = `${Math.round(flip ? rect.top - CARD_GAP - height : below)}px`
}

function ensureCard(): HTMLElement {
  if (card) return card
  const element = document.createElement('div')
  element.className = 'link-card'
  element.setAttribute('role', 'dialog')
  element.style.position = 'fixed'
  element.style.width = `${CARD_WIDTH}px`
  element.addEventListener('pointerenter', cancelHide)
  element.addEventListener('pointerleave', scheduleHide)
  element.addEventListener('mousedown', (event) => event.preventDefault())
  element.addEventListener('click', (event) => {
    const href = shown?.href
    if (!href) return
    event.preventDefault()
    hideCard()
    if (event.metaKey || event.ctrlKey) openExternally(href)
    else requestLinkPeek(href)
  })
  card = element
  return element
}

function onViewportChange(): void {
  if (shown) position(shown.anchor)
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key === 'Escape') hideCard()
}

function showCard(anchor: HTMLElement, href: string): void {
  const element = ensureCard()
  shown = { anchor, href }

  const preview = ensurePreview(href, () => {
    // The fetch may settle long after the pointer moved on.
    if (shown?.href !== href || !card) return
    renderBody(href, readPreview(href))
    position(shown.anchor)
  })
  renderBody(href, preview)

  if (!element.isConnected) {
    document.body.appendChild(element)
    window.addEventListener('scroll', onViewportChange, true)
    window.addEventListener('resize', onViewportChange)
    window.addEventListener('keydown', onKeyDown)
  }
  position(anchor)
}

export function hideCard(): void {
  if (showTimer) { clearTimeout(showTimer); showTimer = null }
  if (hideTimer) { clearTimeout(hideTimer); hideTimer = null }
  shown = null
  if (!card?.isConnected) return
  card.remove()
  window.removeEventListener('scroll', onViewportChange, true)
  window.removeEventListener('resize', onViewportChange)
  window.removeEventListener('keydown', onKeyDown)
}

function cancelHide(): void {
  if (!hideTimer) return
  clearTimeout(hideTimer)
  hideTimer = null
}

function scheduleHide(): void {
  cancelHide()
  hideTimer = setTimeout(hideCard, LEAVE_DELAY_MS)
}

/** Test seam: the card is a module singleton shared by every editor instance. */
export function resetLinkCards(): void {
  hideCard()
  card = null
}

export const LinkCards = Extension.create({
  name: 'linkCards',

  addProseMirrorPlugins() {
    return [new Plugin({
      key: linkCardPluginKey,
      props: {
        handleDOMEvents: {
          mouseover: (_view, event) => {
            const hit = externalAnchorHref(event.target)
            if (!hit) return false
            cancelHide()
            if (shown?.anchor === hit.anchor) return false
            if (showTimer) clearTimeout(showTimer)
            showTimer = setTimeout(() => {
              showTimer = null
              showCard(hit.anchor, hit.href)
            }, shown ? 0 : HOVER_DELAY_MS)
            return false
          },
          mouseout: (_view, event) => {
            if (!externalAnchorHref(event.target)) return false
            // Moving within the same anchor, or onto the card, is not a leave.
            const to = (event as MouseEvent).relatedTarget
            if (to instanceof Node && (card?.contains(to) || externalAnchorHref(to))) return false
            if (showTimer) { clearTimeout(showTimer); showTimer = null }
            scheduleHide()
            return false
          },
          // A click routes to the peek window; the card has served its purpose.
          mousedown: () => {
            if (showTimer) { clearTimeout(showTimer); showTimer = null }
            hideCard()
            return false
          },
        },
      },
      view: () => ({ destroy: hideCard }),
    })]
  },
})

export { readPreview }
