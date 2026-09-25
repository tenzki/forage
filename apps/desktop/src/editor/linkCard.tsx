// Hover preview cards.
//
// Hovering a link pops a card anchored under it: the page title and lead text
// for an external link, or the target bullet's path, children and references
// for an internal `[[` link (or a notice when that bullet was deleted). The
// card is a plain body-attached element rather than a ProseMirror decoration,
// so it never enters the document, the undo history, or the durable event
// stream, and it costs the editor no redecoration passes. Its contents are
// rendered with React into that element.

import { Extension } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { LinkPreviewCard, type LinkPreviewActions, type LinkPreviewModel } from '../components/Outliner/LinkPreviewCard'
import { ensurePreview, readPreview, retryPreview } from './linkPreview'
import { bulletIdAtDom, openExternally, requestLinkPeek } from './externalLinks'
import { collectBacklinks, OUTLINE_INTERNAL_LINK_EVENT } from './internalLinks'
import { collectBullets } from './outlineModel'

const linkCardPluginKey = new PluginKey('outlineLinkCards')

/** Long enough that skimming a paragraph of links pops nothing. */
const HOVER_DELAY_MS = 320
/** Short grace period so the pointer can travel from link to card. */
const LEAVE_DELAY_MS = 180
const CARD_WIDTH = 340
const CARD_GAP = 8
const VIEWPORT_MARGIN = 12
/** Children an internal preview lists before summarising the rest. */
const INTERNAL_PREVIEW_CHILDREN = 3

type HoverTarget =
  | { kind: 'external'; anchor: HTMLElement; href: string }
  | { kind: 'internal'; anchor: HTMLElement; targetId: string }

interface Shown {
  target: HoverTarget
  view: EditorView
}

let card: HTMLElement | null = null
let root: Root | null = null
let shown: Shown | null = null
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

function hoverTarget(target: EventTarget | null): HoverTarget | null {
  const internal = target instanceof Element ? target.closest<HTMLElement>('a[data-internal-node-id]') : null
  if (internal?.dataset.internalNodeId) {
    return { kind: 'internal', anchor: internal, targetId: internal.dataset.internalNodeId }
  }
  const external = externalAnchorHref(target)
  return external ? { kind: 'external', ...external } : null
}

function sameTarget(left: HoverTarget | undefined, right: HoverTarget): boolean {
  return left?.anchor === right.anchor
}

function internalModel(doc: ProseMirrorNode, targetId: string, label: string): LinkPreviewModel {
  const entries = collectBullets(doc)
  const target = entries.find((entry) => entry.id === targetId)
  if (!target) return { kind: 'missing', label: label.trim() || 'Untitled' }
  const titles = new Map(entries.map((entry) => [entry.id, entry.text.trim() || 'Untitled']))
  const depth = target.ancestorIds.length + 1
  const children = entries.filter((entry) => (
    entry.ancestorIds.length === depth && entry.ancestorIds[depth - 1] === targetId
  ))
  return {
    kind: 'internal',
    targetId,
    path: target.ancestorIds.slice(-2).map((id) => titles.get(id) ?? 'Untitled'),
    title: target.text.trim(),
    children: children.slice(0, INTERNAL_PREVIEW_CHILDREN).map((entry) => entry.text.trim()),
    moreCount: Math.max(0, children.length - INTERNAL_PREVIEW_CHILDREN),
    backlinkCount: collectBacklinks(doc, targetId).length,
  }
}

function modelFor({ target, view }: Shown): LinkPreviewModel {
  if (target.kind === 'internal') {
    return internalModel(view.state.doc, target.targetId, target.anchor.textContent ?? '')
  }
  const preview = readPreview(target.href)
  return { kind: 'external', href: target.href, ...preview }
}

/** The document range covered by the internal link mark under `anchor`. */
function internalLinkRange(view: EditorView, anchor: HTMLElement, targetId: string): { from: number; to: number } | null {
  let pos: number
  try {
    pos = view.posAtDOM(anchor, 0)
  } catch {
    return null
  }
  const $pos = view.state.doc.resolve(pos)
  const blockStart = $pos.start()
  // Consecutive text nodes carrying this link form one run; return the run under `pos`.
  let run: { from: number; to: number } | null = null
  let found: { from: number; to: number } | null = null
  $pos.parent.forEach((node, offset) => {
    if (found) return
    const start = blockStart + offset
    const end = start + node.nodeSize
    const linked = node.marks.some((mark) => mark.type.name === 'internalLink' && mark.attrs.targetId === targetId)
    if (!linked) {
      run = null
      return
    }
    run = run ? { from: run.from, to: end } : { from: start, to: end }
    if (pos >= run.from && pos <= run.to) found = run
  })
  return found
}

function actionsFor(current: Shown): LinkPreviewActions {
  const { target, view } = current
  return {
    onPeek: () => {
      if (target.kind !== 'external') return
      hideCard()
      requestLinkPeek(target.href, bulletIdAtDom(view, target.anchor))
    },
    onOpenExternal: () => {
      if (target.kind !== 'external') return
      hideCard()
      openExternally(target.href)
    },
    onRetry: () => {
      if (target.kind !== 'external') return
      retryPreview(target.href, () => rerender(target))
      rerender(target)
    },
    onOpenInternal: () => {
      if (target.kind !== 'internal') return
      hideCard()
      window.dispatchEvent(new CustomEvent(OUTLINE_INTERNAL_LINK_EVENT, { detail: { targetId: target.targetId } }))
    },
    onRelink: () => {
      if (target.kind !== 'internal') return
      const range = internalLinkRange(view, target.anchor, target.targetId)
      hideCard()
      if (!range) return
      // Put the label back behind `[[` so the link picker opens on it.
      const label = view.state.doc.textBetween(range.from, range.to)
      const text = `[[${label}`
      const transaction = view.state.tr.replaceWith(range.from, range.to, view.state.schema.text(text))
      transaction.setSelection(TextSelection.create(transaction.doc, range.from + text.length))
      view.dispatch(transaction)
      view.focus()
    },
    onRemoveLink: () => {
      if (target.kind !== 'internal') return
      const range = internalLinkRange(view, target.anchor, target.targetId)
      hideCard()
      const markType = view.state.schema.marks.internalLink
      if (!range || !markType) return
      view.dispatch(view.state.tr.removeMark(range.from, range.to, markType))
    },
  }
}

function render(current: Shown): void {
  if (!card || !root) return
  const model = modelFor(current)
  card.className = `link-card is-${model.kind}${model.kind === 'external' ? ` is-${model.status}` : ''}`
  card.title = current.target.kind === 'external' ? current.target.href : ''
  const actions = actionsFor(current)
  flushSync(() => root?.render(<LinkPreviewCard model={model} actions={actions} />))
}

function rerender(target: HoverTarget): void {
  if (!shown || !sameTarget(shown.target, target)) return
  render(shown)
  position(shown.target.anchor)
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
  // A click on the card body (not one of its buttons) follows the link.
  element.addEventListener('click', (event) => {
    const current = shown
    if (!current) return
    event.preventDefault()
    const { target } = current
    if (target.kind === 'internal') {
      if (modelFor(current).kind !== 'missing') actionsFor(current).onOpenInternal()
      return
    }
    hideCard()
    if (event.metaKey || event.ctrlKey) openExternally(target.href)
    else requestLinkPeek(target.href, bulletIdAtDom(current.view, target.anchor))
  })
  card = element
  root = createRoot(element)
  return element
}

function onViewportChange(): void {
  if (shown) position(shown.target.anchor)
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key === 'Escape') hideCard()
}

function showCard(view: EditorView, target: HoverTarget): void {
  const element = ensureCard()
  shown = { target, view }

  if (target.kind === 'external') {
    // The fetch may settle long after the pointer moved on.
    ensurePreview(target.href, () => rerender(target))
  }

  if (!element.isConnected) {
    document.body.appendChild(element)
    window.addEventListener('scroll', onViewportChange, true)
    window.addEventListener('resize', onViewportChange)
    window.addEventListener('keydown', onKeyDown)
  }
  render(shown)
  position(target.anchor)
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
  const staleRoot = root
  root = null
  card = null
  // Unmounting synchronously inside a React render would warn; defer it.
  if (staleRoot) queueMicrotask(() => staleRoot.unmount())
}

export const LinkCards = Extension.create({
  name: 'linkCards',

  addProseMirrorPlugins() {
    return [new Plugin({
      key: linkCardPluginKey,
      props: {
        handleDOMEvents: {
          mouseover: (view, event) => {
            const hit = hoverTarget(event.target)
            if (!hit) return false
            cancelHide()
            if (sameTarget(shown?.target, hit)) return false
            if (showTimer) clearTimeout(showTimer)
            showTimer = setTimeout(() => {
              showTimer = null
              showCard(view, hit)
            }, shown ? 0 : HOVER_DELAY_MS)
            return false
          },
          mouseout: (_view, event) => {
            if (!hoverTarget(event.target)) return false
            // Moving within the same anchor, or onto the card, is not a leave.
            const to = (event as MouseEvent).relatedTarget
            if (to instanceof Node && (card?.contains(to) || hoverTarget(to))) return false
            if (showTimer) { clearTimeout(showTimer); showTimer = null }
            scheduleHide()
            return false
          },
          // A click follows the link; the card has served its purpose.
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
