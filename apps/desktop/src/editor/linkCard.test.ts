import { afterEach, describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { BulletAttributes } from './extensions'
import { ExternalLink, OUTLINE_LINK_PEEK_EVENT } from './externalLinks'
import { LinkCards, resetLinkCards } from './linkCard'
import { resetPreviewCache } from './linkPreview'

const fetchMock = vi.fn()
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: (...args: unknown[]) => fetchMock(...args) }))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: () => Promise.resolve() }))

const READER = [
  'Title: Example Domain',
  '',
  'Markdown Content:',
  'An illustrative page for documentation.',
].join('\n')

interface BulletOptions { href?: string; text?: string; internalId?: string }

function bullet(id: string, { href, text = 'Example', internalId }: BulletOptions) {
  const marks = href
    ? [{ type: 'link', attrs: { href, ...(internalId ? { 'data-internal-node-id': internalId } : {}) } }]
    : []
  return {
    type: 'listItem',
    attrs: { nodeId: id },
    content: [{ type: 'paragraph', content: [{ type: 'text', text, ...(href ? { marks } : {}) }] }],
  }
}

function makeEditor(items: ReturnType<typeof bullet>[]): Editor {
  const element = document.createElement('div')
  document.body.appendChild(element)
  return new Editor({
    element,
    extensions: [
      StarterKit.configure({ trailingNode: false, link: { openOnClick: false } }),
      BulletAttributes,
      ExternalLink,
      LinkCards,
    ],
    content: { type: 'doc', content: [{ type: 'bulletList', content: items }] },
  })
}

function hover(editor: Editor, text: string): HTMLAnchorElement {
  const anchor = [...editor.view.dom.querySelectorAll('a')]
    .find((candidate) => candidate.textContent === text)
  if (!anchor) throw new Error(`no anchor for ${text}`)
  anchor.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  return anchor
}

function leave(anchor: HTMLAnchorElement): void {
  anchor.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
}

const cardInBody = () => document.body.querySelector(':scope > .link-card')

describe('link hover cards', () => {
  const editors: Editor[] = []

  function editorWith(items: ReturnType<typeof bullet>[]): Editor {
    const editor = makeEditor(items)
    editors.push(editor)
    return editor
  }

  afterEach(() => {
    editors.splice(0).forEach((editor) => {
      const host = editor.view.dom.parentElement
      editor.destroy()
      host?.remove()
    })
    resetLinkCards()
    resetPreviewCache()
    fetchMock.mockReset()
  })

  it('pops a card over the page when an external link is hovered', async () => {
    const editor = editorWith([bullet('a', { href: 'https://example.com' })])
    expect(cardInBody()).toBeNull()

    hover(editor, 'Example')

    await vi.waitFor(() => expect(cardInBody()).not.toBeNull())
    expect(cardInBody()?.getAttribute('title')).toBe('https://example.com')
    // It hovers over the outline, never inside it.
    expect(editor.view.dom.querySelector('.link-card')).toBeNull()
  })

  it('previews the target bullet of an internal link without fetching', async () => {
    const editor = editorWith([
      bullet('x', { text: 'Target bullet' }),
      bullet('a', { href: 'https://example.com', internalId: 'x' }),
    ])
    // The mark renders the attribute, which is what the anchor test looks at.
    const anchor = editor.view.dom.querySelector('a')
    if (anchor) anchor.dataset.internalNodeId = 'x'

    hover(editor, 'Example')
    await vi.waitFor(() => expect(cardInBody()?.classList.contains('is-internal')).toBe(true))
    expect(cardInBody()?.querySelector('.link-card-heading')?.textContent).toBe('Target bullet')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('explains an internal link whose bullet was deleted', async () => {
    const editor = editorWith([bullet('a', { href: 'https://example.com', internalId: 'gone' })])
    const anchor = editor.view.dom.querySelector('a')
    if (anchor) anchor.dataset.internalNodeId = 'gone'

    hover(editor, 'Example')
    await vi.waitFor(() => expect(cardInBody()?.classList.contains('is-missing')).toBe(true))
    expect(cardInBody()?.textContent).toContain('Linked bullet no longer exists')
  })

  it('offers a retry when the site does not respond', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, text: () => Promise.resolve('') })
    const editor = editorWith([bullet('a', { href: 'https://example.com' })])

    hover(editor, 'Example')
    await vi.waitFor(() => expect(cardInBody()?.classList.contains('is-error')).toBe(true))
    expect(cardInBody()?.textContent).toContain('No preview')
    expect(cardInBody()?.textContent).toContain('Retry')
  })

  it('fills in the fetched title once the preview settles', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve(READER) })
    const editor = editorWith([bullet('a', { href: 'https://example.com' })])

    hover(editor, 'Example')
    await vi.waitFor(() => {
      expect(cardInBody()?.querySelector('.link-card-title')?.textContent).toBe('Example Domain')
    })
    expect(cardInBody()?.querySelector('.link-card-description')?.textContent)
      .toBe('An illustrative page for documentation.')
  })

  it('shows a placeholder while the fetch is still in flight', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}))
    const editor = editorWith([bullet('a', { href: 'https://example.com' })])

    hover(editor, 'Example')
    await vi.waitFor(() => expect(cardInBody()).not.toBeNull())
    expect(cardInBody()?.querySelector('.link-card-title')?.textContent).toBe('Loading preview…')
    expect(cardInBody()?.querySelector('.link-card-host')?.textContent).toBe('example.com')
  })

  it('hides again shortly after the pointer leaves', async () => {
    const editor = editorWith([bullet('a', { href: 'https://example.com' })])
    const anchor = hover(editor, 'Example')
    await vi.waitFor(() => expect(cardInBody()).not.toBeNull())

    leave(anchor)
    await vi.waitFor(() => expect(cardInBody()).toBeNull())
  })

  it('keeps the card out of the document entirely', async () => {
    const editor = editorWith([bullet('a', { href: 'https://example.com' })])
    hover(editor, 'Example')
    await vi.waitFor(() => expect(cardInBody()).not.toBeNull())

    const json = JSON.stringify(editor.getJSON())
    expect(json).not.toContain('link-card')
    expect(json).not.toContain('Loading preview')
  })

  it('asks for a peek when the card is clicked', async () => {
    const editor = editorWith([bullet('a', { href: 'https://example.com' })])
    hover(editor, 'Example')
    await vi.waitFor(() => expect(cardInBody()).not.toBeNull())

    const peeks: string[] = []
    const onPeek = (event: Event) => peeks.push((event as CustomEvent<{ href: string }>).detail.href)
    window.addEventListener(OUTLINE_LINK_PEEK_EVENT, onPeek)
    cardInBody()?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    window.removeEventListener(OUTLINE_LINK_PEEK_EVENT, onPeek)

    expect(peeks).toEqual(['https://example.com'])
    // Clicking through dismisses the card; the peek window takes over.
    expect(cardInBody()).toBeNull()
  })
})
