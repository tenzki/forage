// The link peek (Screen 08 in docs/desktop.pen): a pane beside the outline.
// It opens on the live site, shown through a native webview laid over the page
// surface (see pagePeek.ts) since the app's CSP forbids framing remote origins.
// "Reader" swaps in clean text fetched through Jina Reader on demand. Either
// way the user can clip into the outline under the bullet that held the link,
// or ask an agent to summarize the page there.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { Editor } from '@tiptap/react'
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  Copy,
  FileText,
  Globe,
  ListPlus,
  Lock,
  RotateCw,
  Sparkles,
  X,
} from 'lucide-react'
import { isExtensionSkill } from '../../agent/definitions'
import { requestSkillRun } from '../../agent/skillRuns'
import { openExternally } from '../../editor/externalLinks'
import { appendChildBullet, currentBulletId, findBullet } from '../../editor/outlineModel'
import {
  fetchReaderDocument,
  type ReaderBlock,
  type ReaderDocument,
  type ReaderInline,
} from '../../editor/readerDocument'
import { documentEditor } from '../../editor/documentAccess'
import { useSettingsStore } from '../../store/settingsStore'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { SegmentedControl } from '../ui/SegmentedControl'
import { boundsOf, PageLease, observePageGeometry, hasPageOverlay, pagePeekAvailable, focusApplication, type PageAction, type PageState } from './pagePeek'

type PeekMode = 'reader' | 'page'

type ReaderState =
  | { status: 'loading' }
  | { status: 'ready'; document: ReaderDocument }
  | { status: 'error'; message: string }

const COPIED_FEEDBACK_MS = 1400
const CLIPPED_FEEDBACK_MS = 1800
/** Skills tried, in order, for "Summarize into outline". */
const SUMMARY_SKILLS = ['research', 'ask']

export function splitUrl(href: string): { host: string; rest: string } {
  try {
    const url = new URL(href)
    const rest = `${url.pathname}${url.search}`.replace(/^\/$/u, '')
    return { host: url.hostname.replace(/^www\./u, ''), rest }
  } catch {
    return { host: href, rest: '' }
  }
}

/** Equal up to a fragment or a trailing slash, which the page may add or drop. */
function sameUrl(left: string, right: string): boolean {
  const key = (href: string) => {
    try {
      const url = new URL(href)
      url.hash = ''
      return url.href.replace(/\/$/u, '')
    } catch {
      return href
    }
  }
  return key(left) === key(right)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function Inline({ nodes, onNavigate }: { nodes: ReaderInline[]; onNavigate: (href: string, external: boolean) => void }): ReactNode {
  return nodes.map((node, index) => {
    if (node.type === 'text') return node.text
    if (node.type === 'code') return <code key={index}>{node.text}</code>
    const children = <Inline nodes={node.children} onNavigate={onNavigate} />
    if (node.type === 'strong') return <strong key={index}>{children}</strong>
    if (node.type === 'em') return <em key={index}>{children}</em>
    const { href } = node as Extract<ReaderInline, { type: 'link' }>
    return (
      <a
        key={index}
        href={href}
        onClick={(event) => {
          event.preventDefault()
          onNavigate(href, event.metaKey || event.ctrlKey)
        }}
      >
        {children}
      </a>
    )
  })
}

function Block({ block, onNavigate }: { block: ReaderBlock; onNavigate: (href: string, external: boolean) => void }) {
  if (block.type === 'rule') return <hr />
  if (block.type === 'code') return <pre><code>{block.text}</code></pre>
  if (block.type === 'list') {
    const items = block.items.map((item, index) => <li key={index}><Inline nodes={item} onNavigate={onNavigate} /></li>)
    return block.ordered ? <ol>{items}</ol> : <ul>{items}</ul>
  }
  const content = <Inline nodes={block.content} onNavigate={onNavigate} />
  if (block.type === 'quote') return <blockquote>{content}</blockquote>
  if (block.type === 'paragraph') return <p>{content}</p>
  // Article headings sit under the page title, so they start one level down.
  const Heading = (['h2', 'h3', 'h4', 'h5'] as const)[block.level - 1]!
  return <Heading>{content}</Heading>
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
}

function formatPublished(value: string): string | null {
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) return null
  return new Date(parsed).toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' })
}

function sentenceCount(text: string): number {
  return text.split(/(?<=[.!?])\s+/u).filter((sentence) => sentence.trim()).length
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text)
}

export function LinkPeekPane({
  editor,
  href: openedHref,
  sourceNodeId,
  onClose,
  navigation,
  paneActions,
  paneId,
  active = true,
  visible = true,
  onOpenRight,
}: {
  paneId?: string
  active?: boolean
  visible?: boolean
  onOpenRight?: (href: string) => void
  paneActions?: React.ReactNode
  editor: Editor | null
  href: string
  sourceNodeId?: string
  onClose: () => void
  navigation?: { scrollTop?: number; onScroll?: (scrollTop: number) => void; canBack: boolean; canForward: boolean; onNavigate: (href: string) => void; onBack: () => void; onForward: () => void }
}) {
  const owner = useRef(paneId ?? crypto.randomUUID()).current
  const canonical = editor ? documentEditor(editor) : null
  const originalSource = useRef(sourceNodeId ?? (!paneId && canonical ? currentBulletId(canonical) ?? undefined : undefined)).current
  const [, updateDocument] = useState(0)
  useEffect(() => {
    if (!canonical) return
    const update = () => updateDocument(n => n + 1)
    canonical.on('transaction', update)
    return () => { canonical.off('transaction', update) }
  }, [canonical])
  const [resourceToken, setResourceToken] = useState(0)
  const lease = useRef<PageLease | null>(null)
  const nativeUrl = useRef<string | null>(null)
  const [readerLink, setReaderLink] = useState<{ href: string; x: number; y: number } | null>(null)
  const paneRef = useRef<HTMLElement>(null)
  const [compactHeader, setCompactHeader] = useState(false)
  useLayoutEffect(() => {
    if (!paneRef.current) return
    const measure = () => { const width = paneRef.current!.getBoundingClientRect().width; setCompactHeader(width > 0 && width < 300) }
    const observer = new ResizeObserver(measure)
    observer.observe(paneRef.current)
    measure()
    return () => observer.disconnect()
  }, [])
  const [history, setHistory] = useState({ entries: [openedHref], index: 0 })
  const [reloadToken, setReloadToken] = useState(0)
  const [state, setState] = useState<ReaderState>({ status: 'loading' })
  const [selection, setSelection] = useState('')
  const [copied, setCopied] = useState(false)
  const [clipped, setClipped] = useState(false)
  const pageLive = pagePeekAvailable()
  // The live page is the default; the reader is fetched only once it is asked for.
  const [mode, setMode] = useState<PeekMode>(pageLive ? 'page' : 'reader')
  const modeRef = useRef(mode); modeRef.current = mode
  const pageAdmission = useRef({ mode: 'reader' as PeekMode, resourceToken: -1 })
  const [page, setPage] = useState<PageState | null>(null)
  const [pageError, setPageError] = useState<string | null>(null)
  const [pageStill, setPageStill] = useState<string | null>(null)
  /** The reader load already started for `href` and `reloadToken`, if any. */
  const readerLoad = useRef<string | null>(null)
  const readerRef = useRef<HTMLDivElement>(null)
  const pageRef = useRef<HTMLDivElement>(null)
  const skills = useSettingsStore((store) => store.skills)
  const href = navigation ? openedHref : history.entries[history.index]!
  const navigationRef = useRef(navigation); navigationRef.current = navigation
  const locationRef = useRef(href); locationRef.current = href
  useEffect(() => {
    if (readerRef.current) readerRef.current.scrollTop = navigation?.scrollTop ?? 0
  }, [href, navigation?.scrollTop, state.status])

  // A new link from the outline starts a fresh history.
  useEffect(() => {
    setHistory({ entries: [openedHref], index: 0 })
  }, [openedHref])

  useEffect(() => {
    if (mode !== 'reader') return undefined
    const key = `${reloadToken}:${href}`
    if (readerLoad.current === key) return undefined
    readerLoad.current = key
    const controller = new AbortController()
    let settled = false
    setState({ status: 'loading' })
    setSelection('')
    fetchReaderDocument(href, controller.signal)
      .then((document) => {
        if (!controller.signal.aborted) setState({ status: 'ready', document })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setState({ status: 'error', message: errorMessage(error) })
      })
      .finally(() => {
        settled = true
      })
    if (!navigation) readerRef.current?.scrollTo?.({ top: 0 })
    return () => {
      controller.abort()
      // Leaving mid-load: fetch again next time the reader is shown.
      if (!settled && readerLoad.current === key) readerLoad.current = null
    }
  }, [href, reloadToken, mode])

  useEffect(() => {
    if (!pageLive) return
    const resource = new PageLease(owner, next => {
      if (modeRef.current !== 'page') return
      nativeUrl.current = next.url
      if (navigationRef.current && !sameUrl(locationRef.current, next.url)) {
        locationRef.current = next.url
        navigationRef.current.onNavigate(next.url)
      }
      setPage(current => ({ ...next, title: next.title ?? (current && sameUrl(current.url, next.url) ? current.title : null), loading: next.title != null ? current?.loading ?? false : next.loading }))
    })
    lease.current = resource
    return () => { resource.dispose(); if (lease.current === resource) lease.current = null }
  }, [owner, pageLive, resourceToken])

  useEffect(() => {
    const prior = pageAdmission.current
    pageAdmission.current = { mode, resourceToken }
    if (!pageLive) return
    if (mode !== 'page') { lease.current?.suspend(); return }
    let cancelled = false
    setPageError(null)
    setPage(current => current && sameUrl(current.url, href) ? current : null)
    // Reader carries a live navigation back without restarting its native history.
    const nativeEcho = prior.mode === 'page' && prior.resourceToken === resourceToken && nativeUrl.current != null && sameUrl(nativeUrl.current, href)
    if (!nativeEcho) void lease.current?.load(href).catch(error => {
      if (!cancelled) setPageError(errorMessage(error))
    })
    return () => { cancelled = true }
  }, [href, mode, pageLive, resourceToken])

  useEffect(() => {
    if (!pageLive || mode !== 'page' || pageError || (page && !page.loading)) return
    const timer = window.setTimeout(() => setPageError('The page did not finish loading. Retry, use Reader, or open it in your browser.'), 20_000)
    return () => window.clearTimeout(timer)
  }, [href, mode, pageLive, page?.loading, pageError, resourceToken])

  useEffect(() => {
    if (!pageLive || mode !== 'page' || !pageRef.current) return
    const surface = pageRef.current
    const resource = lease.current
    let cancelled = false, covered = false, focused = false, turn = 0, still: string | null = null, placed = ''
    const release = () => { if (still) URL.revokeObjectURL(still); still = null }
    const update = () => {
      const nextCovered = hasPageOverlay()
      if (nextCovered !== covered) {
        covered = nextCovered; const current = ++turn
        if (covered && visible) {
          focused = false
          void focusApplication().catch(() => undefined)
          // Hiding is immediate; a slow snapshot cannot obstruct a dialog.
          void resource?.snapshot().catch(() => null).then(picture => {
            if (cancelled || current !== turn) { if (picture) URL.revokeObjectURL(picture); return }
            release(); still = picture ?? null; setPageStill(still)
          })
        } else { release(); setPageStill(null) }
      }
      const bounds = boundsOf(surface)
      const show = visible && !covered && !pageError && !surface.closest('[hidden]')
      const key = JSON.stringify([bounds, show])
      if (key === placed) return
      placed = key
      void resource?.present(bounds, show).then(() => { if (!cancelled && show && active && !focused && !hasPageOverlay()) { focused = true; return resource?.focus() } }).catch(error => { if (!cancelled) setPageError(errorMessage(error)) })
    }
    const stop = observePageGeometry(surface, update)
    return () => {
      cancelled = true; turn++; stop(); release(); setPageStill(null)
      void resource?.present(boundsOf(surface), false).catch(() => undefined)
    }
  }, [mode, pageLive, visible, active, pageError, resourceToken])

  useEffect(() => {
    const onSelectionChange = () => {
      const current = window.getSelection()
      const reader = readerRef.current
      if (!current || current.isCollapsed || !reader || !current.anchorNode || !reader.contains(current.anchorNode)) {
        setSelection('')
        return
      }
      setSelection(current.toString().replace(/\s+/gu, ' ').trim())
    }
    document.addEventListener('selectionchange', onSelectionChange)
    return () => document.removeEventListener('selectionchange', onSelectionChange)
  }, [])

  useEffect(() => {
    if (!copied) return undefined
    const timer = window.setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS)
    return () => window.clearTimeout(timer)
  }, [copied])

  useEffect(() => {
    if (!clipped) return undefined
    const timer = window.setTimeout(() => setClipped(false), CLIPPED_FEEDBACK_MS)
    return () => window.clearTimeout(timer)
  }, [clipped])

  const navigate = useCallback((next: string, external: boolean) => {
    if (external || next.startsWith('mailto:')) {
      openExternally(next)
      return
    }
    if (navigation) { navigation.onNavigate(next); return }
    setHistory((current) => ({
      entries: [...current.entries.slice(0, current.index + 1), next],
      index: current.index + 1,
    }))
  }, [navigation])

  function changeMode(next: PeekMode) {
    if (next === mode) return
    // Carry pages visited in the live view over, so the reader shows the same one.
    if (next === 'reader' && page && !sameUrl(page.url, href)) navigate(page.url, false)
    setMode(next)
  }

  function step(action: PageAction) {
    void lease.current?.navigate(action).catch((error: unknown) => setPageError(errorMessage(error)))
  }

  // Stable source ownership survives focus changes, navigation and pane teardown.
  const targetNodeId = (): string | null => canonical && originalSource && findBullet(canonical.state.doc, originalSource) ? originalSource : null

  const inPage = mode === 'page'
  const currentHref = inPage && page ? page.url : href
  const article = state.status === 'ready' ? state.document : null
  const summarySkill = SUMMARY_SKILLS
    .map((label) => skills.find((skill) => skill.label === label && !isExtensionSkill(skill)))
    .find(Boolean) ?? skills.find((skill) => !isExtensionSkill(skill))
  const target = targetNodeId()

  function clip() {
    if (!canonical || !target) return
    const readerArticle = article && sameUrl(article.href, currentHref) ? article : null
    const host = readerArticle?.host ?? splitUrl(currentHref).host
    const title = (inPage ? page?.title : null) || readerArticle?.title || host
    // The live page's selection lives in another webview, out of reach.
    const quote = inPage ? '' : selection
    appendChildBullet(canonical, target, quote
      ? [{ text: `“${quote}” — ` }, { text: host, href: currentHref }]
      : [{ text: title, href: currentHref }])
    setClipped(true)
  }

  function summarize() {
    if (!canonical || !target || !summarySkill) return
    const prompt = `Summarize ${currentHref} into the key points as bullets.`
    const invocationNodeId = appendChildBullet(canonical, target, `/${summarySkill.label} ${prompt}`)
    if (!invocationNodeId) return
    requestSkillRun({ invocationNodeId, skillLabel: summarySkill.label, prompt })
  }

  const { host, rest } = splitUrl(currentHref)
  const secure = currentHref.startsWith('https:')
  const sentences = selection && !inPage ? sentenceCount(selection) : 0
  const published = article?.published ? formatPublished(article.published) : null

  return (
    <aside data-page-owner={owner} ref={paneRef} className={`link-peek-pane${compactHeader ? ' is-compact' : ''}`} aria-label="Link preview">
      <div className="link-peek-toolbar">
        <IconButton
          label="Back"
          disabled={inPage ? !pageLive : navigation ? !navigation.canBack : history.index === 0}
          onClick={() => inPage
            ? step('back')
            : navigation ? navigation.onBack() : setHistory((current) => ({ ...current, index: Math.max(0, current.index - 1) }))}
        >
          <ArrowLeft size={15} />
        </IconButton>
        <IconButton
          label="Forward"
          disabled={inPage ? !pageLive : navigation ? !navigation.canForward : history.index >= history.entries.length - 1}
          onClick={() => inPage
            ? step('forward')
            : navigation ? navigation.onForward() : setHistory((current) => ({ ...current, index: Math.min(current.entries.length - 1, current.index + 1) }))}
        >
          <ArrowRight size={15} />
        </IconButton>
        <div className="link-peek-address" title={currentHref}>
          {secure && <Lock size={12} aria-label="Secure connection" />}
          <span className="link-peek-address-host">{host}</span>
          <span className="link-peek-address-path">{rest}</span>
        </div>
        {(!compactHeader || !paneActions) && (<SegmentedControl
          ariaLabel="Peek mode"
          value={mode}
          options={[{ value: 'reader', label: 'Reader' }, { value: 'page', label: 'Page' }]}
          onValueChange={(next) => changeMode(next as PeekMode)}
        />)}
        {paneActions ? <div className="web-overflow"><details onToggle={event => event.currentTarget.dataset.paneMenu = event.currentTarget.open ? 'open' : ''}><summary aria-label="Web actions">⋯</summary><div className="pane-menu">{compactHeader && (<SegmentedControl
          ariaLabel="Peek mode"
          value={mode}
          options={[{ value: 'reader', label: 'Reader' }, { value: 'page', label: 'Page' }]}
          onValueChange={(next) => changeMode(next as PeekMode)}
        />)}
        <IconButton
          label="Reload"
          disabled={inPage && !pageLive}
          onClick={() => inPage ? step('reload') : setReloadToken((token) => token + 1)}
        >
          <RotateCw size={15} className={inPage && page?.loading ? 'is-spinning' : undefined} />
        </IconButton>
        <IconButton
          label={copied ? 'Link copied' : 'Copy link'}
          onClick={() => void copyText(currentHref).then(() => setCopied(true)).catch(() => undefined)}
        >
          {copied ? <Check size={15} /> : <Copy size={15} />}
        </IconButton>
        <IconButton label="Open in browser" onClick={() => openExternally(currentHref)}>
          <ArrowUpRight size={15} />
        </IconButton>
</div></details></div> : <>        <IconButton
          label="Reload"
          disabled={inPage && !pageLive}
          onClick={() => inPage ? step('reload') : setReloadToken((token) => token + 1)}
        >
          <RotateCw size={15} className={inPage && page?.loading ? 'is-spinning' : undefined} />
        </IconButton>
        <IconButton
          label={copied ? 'Link copied' : 'Copy link'}
          onClick={() => void copyText(currentHref).then(() => setCopied(true)).catch(() => undefined)}
        >
          {copied ? <Check size={15} /> : <Copy size={15} />}
        </IconButton>
        <IconButton label="Open in browser" onClick={() => openExternally(currentHref)}>
          <ArrowUpRight size={15} />
        </IconButton>
        <IconButton label="Close preview" data-preserve-pane-focus onMouseDown={event => event.preventDefault()} onClick={onClose}>
          <X size={15} />
        </IconButton>
</>}
        {paneActions}
      </div>

      <div className="link-peek-reader" onContextMenu={event => {
        const link = (event.target as Element).closest<HTMLAnchorElement>('a[href]')
        if (!link || !onOpenRight || !/^https?:/u.test(link.href)) return
        event.preventDefault(); setReaderLink({ href: link.href, x: event.clientX, y: event.clientY })
      }} ref={readerRef} hidden={inPage} onScroll={event => navigation?.onScroll?.(event.currentTarget.scrollTop)}>
        {state.status === 'loading' && (
          <div className="link-peek-status" role="status">Fetching reader view…</div>
        )}
        {state.status === 'error' && (
          <div className="link-peek-status is-error" role="alert">
            <strong>No reader view for this page.</strong>
            <span>{state.message}</span>
            <div className="link-peek-status-actions">
              <Button size="sm" onClick={() => setReloadToken((token) => token + 1)}>Retry</Button>
              <Button size="sm" onClick={() => changeMode('page')}>Show page</Button>
              <Button size="sm" onClick={() => openExternally(currentHref)}>Open in browser</Button>
            </div>
          </div>
        )}
        {article && (
          <article className="link-peek-article">
            <p className="link-peek-meta">{article.host}  ·  {article.minutes} min read</p>
            <h1>{article.title}</h1>
            {published && <p className="link-peek-byline">Published {published}</p>}
            {article.blocks.map((block, index) => <Block key={index} block={block} onNavigate={navigate} />)}
          </article>
        )}
      </div>

      {readerLink && <div role="menu" className="pane-menu" style={{ position: 'fixed', left: readerLink.x, top: readerLink.y }} onKeyDown={event => { if (event.key === 'Escape') setReaderLink(null) }}>
        <button autoFocus role="menuitem" onClick={() => { onOpenRight?.(readerLink.href); setReaderLink(null) }}>Open in right pane</button>
        <button role="menuitem" onClick={() => { openExternally(readerLink.href); setReaderLink(null) }}>Open in browser</button>
        <button role="menuitem" onClick={() => setReaderLink(null)}>Cancel</button>
      </div>}
      {inPage && (
        <div className="link-peek-page" ref={pageRef}>
          {/* The live page is a native view drawn over this box; what is here
              shows only while it loads, or when it cannot be shown at all. */}
          {pageStill && <img className="link-peek-page-still" src={pageStill} alt="" />}
          {(!pageLive || pageError) && (
            <div className="link-peek-status" role={pageError ? 'alert' : 'status'}>
              <strong>{pageError ? 'This page could not be shown here.' : 'Live pages open in the desktop app.'}</strong>
              {pageError && <span>{pageError}</span>}
              <div className="link-peek-status-actions">
                <Button size="sm" onClick={() => { nativeUrl.current = null; setPageError(null); setResourceToken(n => n + 1) }}>Retry</Button>
                <Button size="sm" onClick={() => changeMode('reader')}>Reader view</Button>
                <Button size="sm" onClick={() => openExternally(currentHref)}>Open in browser</Button>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="link-peek-footer">
        <span className="link-peek-footer-status">
          {inPage ? <Globe size={12} aria-hidden="true" /> : <FileText size={12} aria-hidden="true" />}
          {[
            inPage ? 'Live page' : 'Reader view',
            inPage && page?.loading ? 'loading…' : null,
            !inPage && article ? `fetched ${formatTime(article.fetchedAt)}` : null,
            sentences ? `${sentences} ${sentences === 1 ? 'sentence' : 'sentences'} selected` : null,
            clipped ? 'clipped' : null,
            !target ? 'Original linking bullet unavailable' : null,
          ].filter(Boolean).join(' · ')}
        </span>
        <div className="link-peek-footer-actions">
          <Button
            icon={<ListPlus aria-hidden="true" />}
            disabled={!target}
            title={selection && !inPage ? 'Add the selected text under the linking bullet' : 'Add a link to this page under the linking bullet'}
            onMouseDown={(event) => event.preventDefault()}
            onClick={clip}
          >
            Clip to outline
          </Button>
          <Button
            variant="agent"
            icon={<Sparkles aria-hidden="true" />}
            disabled={!target || !summarySkill}
            title={summarySkill ? `Run /${summarySkill.label} on this page` : 'Add a skill in Settings first'}
            onClick={summarize}
          >
            Summarize into outline
          </Button>
        </div>
      </div>
    </aside>
  )
}
