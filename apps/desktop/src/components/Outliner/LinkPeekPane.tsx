// The link peek (Screen 08 in docs/desktop.pen): a pane beside the outline.
// It opens on the live site, shown through a native webview laid over the page
// surface (see pagePeek.ts) since the app's CSP forbids framing remote origins.
// "Reader" swaps in clean text fetched through Jina Reader on demand. Either
// way the user can clip into the outline under the bullet that held the link,
// or ask an agent to summarize the page there.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
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
import { useSettingsStore } from '../../store/settingsStore'
import { Button } from '../ui/Button'
import { IconButton } from '../ui/IconButton'
import { SegmentedControl } from '../ui/SegmentedControl'
import {
  boundsOf,
  closePage,
  navigatePage,
  loadPage,
  onPageState,
  pagePeekAvailable,
  setPageBounds,
  setPageVisible,
  showPage,
  snapshotPage,
  type PageAction,
  type PageState,
} from './pagePeek'

type PeekMode = 'reader' | 'page'

type ReaderState =
  | { status: 'loading' }
  | { status: 'ready'; document: ReaderDocument }
  | { status: 'error'; message: string }

const COPIED_FEEDBACK_MS = 1400
/** Frames the page surface must hold still before the live page is laid over it. */
const SURFACE_STILL_FRAMES = 3
/** Open the page regardless after this long, should the layout never settle. */
const SURFACE_SETTLE_MAX_MS = 800
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
}: {
  editor: Editor | null
  href: string
  sourceNodeId?: string
  onClose: () => void
}) {
  const [history, setHistory] = useState({ entries: [openedHref], index: 0 })
  const [reloadToken, setReloadToken] = useState(0)
  const [state, setState] = useState<ReaderState>({ status: 'loading' })
  const [selection, setSelection] = useState('')
  const [copied, setCopied] = useState(false)
  const [clipped, setClipped] = useState(false)
  const pageLive = pagePeekAvailable()
  // The live page is the default; the reader is fetched only once it is asked for.
  const [mode, setMode] = useState<PeekMode>(pageLive ? 'page' : 'reader')
  const [page, setPage] = useState<PageState | null>(null)
  const [pageError, setPageError] = useState<string | null>(null)
  const [pageStill, setPageStill] = useState<string | null>(null)
  /** The reader load already started for `href` and `reloadToken`, if any. */
  const readerLoad = useRef<string | null>(null)
  const readerRef = useRef<HTMLDivElement>(null)
  const pageRef = useRef<HTMLDivElement>(null)
  const skills = useSettingsStore((store) => store.skills)
  const href = history.entries[history.index]!

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
    readerRef.current?.scrollTo({ top: 0 })
    return () => {
      controller.abort()
      // Leaving mid-load: fetch again next time the reader is shown.
      if (!settled && readerLoad.current === key) readerLoad.current = null
    }
  }, [href, reloadToken, mode])

  // Show the live page over the page surface, or hide it while the reader is up.
  //
  // The page is a native view on top of this webview, so it has to follow the
  // surface wherever the layout moves it; the surface is re-measured every
  // frame, since not every move is a resize. The page starts loading at once,
  // out of sight, but is only shown once the surface holds still: the pane
  // opens with a column transition, and WebKit does not repaint a loading page
  // it has been stretched over, leaving the newly covered area blank.
  useEffect(() => {
    if (!pageLive) return undefined
    const surface = pageRef.current
    if (mode !== 'page' || !surface) {
      void setPageVisible(false).catch(() => undefined)
      return undefined
    }
    setPageError(null)
    setPage((current) => current && sameUrl(current.url, href) ? current : null)

    let cancelled = false
    let failed = false
    const fail = (error: unknown) => {
      failed = true
      if (!cancelled) setPageError(errorMessage(error))
    }
    loadPage(href).catch(fail)
    let phase: 'settling' | 'opening' | 'open' = 'settling'
    let frame = 0
    let placed = ''
    let stillFrames = 0
    const startedAt = performance.now()
    const follow = () => {
      const bounds = boundsOf(surface)
      const key = `${bounds.x},${bounds.y},${bounds.width},${bounds.height},${bounds.viewportWidth},${bounds.viewportHeight}`
      if (failed) return
      if (phase === 'settling') {
        stillFrames = key === placed ? stillFrames + 1 : 0
        placed = key
        if (stillFrames >= SURFACE_STILL_FRAMES || performance.now() - startedAt > SURFACE_SETTLE_MAX_MS) {
          phase = 'opening'
          showPage(bounds)
            .then(() => {
              phase = 'open'
            })
            .catch(fail)
        }
      } else if (phase === 'open' && key !== placed) {
        placed = key
        void setPageBounds(bounds).catch(() => {
          placed = ''
        })
      }
      frame = requestAnimationFrame(follow)
    }
    frame = requestAnimationFrame(follow)
    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
    }
  }, [mode, href, pageLive])

  // A modal dialog is HTML, and the page is a native view over the HTML, so it
  // would sit on top of the dialog. Step it aside while one is up, leaving a
  // picture of it in its place so the pane does not blank out.
  useEffect(() => {
    if (!pageLive || mode !== 'page') return undefined
    let covered = false
    let turn = 0
    let still: string | null = null
    const release = () => {
      if (still) URL.revokeObjectURL(still)
      still = null
    }
    const checkModal = () => {
      const next = Boolean(document.querySelector('[aria-modal="true"]'))
      if (next === covered) return
      covered = next
      const current = ++turn
      if (covered) {
        void snapshotPage().catch(() => null).then((picture) => {
          if (current !== turn) {
            if (picture) URL.revokeObjectURL(picture)
            return
          }
          release()
          still = picture
          setPageStill(picture)
          return setPageVisible(false)
        }).catch(() => undefined)
      } else {
        void setPageVisible(true).catch(() => undefined).then(() => {
          // Drop the picture only once the page is back over it.
          requestAnimationFrame(() => {
            if (current !== turn) return
            setPageStill(null)
            release()
          })
        })
      }
    }
    const modals = new MutationObserver(checkModal)
    modals.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-modal'] })
    checkModal()
    return () => {
      modals.disconnect()
      turn += 1
      setPageStill(null)
      release()
    }
  }, [mode, pageLive])

  useEffect(() => {
    if (!pageLive) return undefined
    let disposed = false
    let unlisten: (() => void) | null = null
    void onPageState((next) => {
      setPage((current) => next.title != null
        // A title can land mid-load; it says nothing about loading.
        ? { url: next.url, loading: current?.loading ?? false, title: next.title }
        : { url: next.url, loading: next.loading, title: current && sameUrl(current.url, next.url) ? current.title : null })
    })
      .then((stop) => {
        if (disposed) stop()
        else unlisten = stop
      })
      .catch(() => undefined)
    return () => {
      disposed = true
      unlisten?.()
      void closePage().catch(() => undefined)
    }
  }, [pageLive])

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
    if (external) {
      openExternally(next)
      return
    }
    setHistory((current) => ({
      entries: [...current.entries.slice(0, current.index + 1), next],
      index: current.index + 1,
    }))
  }, [])

  function changeMode(next: PeekMode) {
    if (next === mode) return
    // Carry pages visited in the live view over, so the reader shows the same one.
    if (next === 'reader' && page && !sameUrl(page.url, href)) navigate(page.url, false)
    setMode(next)
  }

  function step(action: PageAction) {
    void navigatePage(action).catch((error: unknown) => setPageError(errorMessage(error)))
  }

  /** Where clips and summaries go: the bullet that held the link, else the current one. */
  const targetNodeId = (): string | null => {
    if (!editor) return null
    if (sourceNodeId && findBullet(editor.state.doc, sourceNodeId)) return sourceNodeId
    return currentBulletId(editor)
  }

  const inPage = mode === 'page'
  const currentHref = inPage && page ? page.url : href
  const article = state.status === 'ready' ? state.document : null
  const summarySkill = SUMMARY_SKILLS
    .map((label) => skills.find((skill) => skill.label === label && !isExtensionSkill(skill)))
    .find(Boolean) ?? skills.find((skill) => !isExtensionSkill(skill))
  const target = editor ? targetNodeId() : null

  function clip() {
    if (!editor || !target) return
    const readerArticle = article && sameUrl(article.href, currentHref) ? article : null
    const host = readerArticle?.host ?? splitUrl(currentHref).host
    const title = (inPage ? page?.title : null) || readerArticle?.title || host
    // The live page's selection lives in another webview, out of reach.
    const quote = inPage ? '' : selection
    appendChildBullet(editor, target, quote
      ? [{ text: `“${quote}” — ` }, { text: host, href: currentHref }]
      : [{ text: title, href: currentHref }])
    setClipped(true)
  }

  function summarize() {
    if (!editor || !target || !summarySkill) return
    const prompt = `Summarize ${currentHref} into the key points as bullets.`
    const invocationNodeId = appendChildBullet(editor, target, `/${summarySkill.label} ${prompt}`)
    if (!invocationNodeId) return
    requestSkillRun({ invocationNodeId, skillLabel: summarySkill.label, prompt })
  }

  const { host, rest } = splitUrl(currentHref)
  const secure = currentHref.startsWith('https:')
  const sentences = selection && !inPage ? sentenceCount(selection) : 0
  const published = article?.published ? formatPublished(article.published) : null

  return (
    <aside className="link-peek-pane" aria-label="Link preview">
      <div className="link-peek-toolbar">
        <IconButton
          label="Back"
          disabled={inPage ? !pageLive : history.index === 0}
          onClick={() => inPage
            ? step('back')
            : setHistory((current) => ({ ...current, index: Math.max(0, current.index - 1) }))}
        >
          <ArrowLeft size={15} />
        </IconButton>
        <IconButton
          label="Forward"
          disabled={inPage ? !pageLive : history.index >= history.entries.length - 1}
          onClick={() => inPage
            ? step('forward')
            : setHistory((current) => ({ ...current, index: Math.min(current.entries.length - 1, current.index + 1) }))}
        >
          <ArrowRight size={15} />
        </IconButton>
        <IconButton
          label="Reload"
          disabled={inPage && !pageLive}
          onClick={() => inPage ? step('reload') : setReloadToken((token) => token + 1)}
        >
          <RotateCw size={15} className={inPage && page?.loading ? 'is-spinning' : undefined} />
        </IconButton>
        <div className="link-peek-address" title={currentHref}>
          {secure && <Lock size={12} aria-label="Secure connection" />}
          <span className="link-peek-address-host">{host}</span>
          <span className="link-peek-address-path">{rest}</span>
        </div>
        <SegmentedControl
          ariaLabel="Peek mode"
          value={mode}
          options={[{ value: 'reader', label: 'Reader' }, { value: 'page', label: 'Page' }]}
          onValueChange={(next) => changeMode(next as PeekMode)}
        />
        <IconButton
          label={copied ? 'Link copied' : 'Copy link'}
          onClick={() => void copyText(currentHref).then(() => setCopied(true)).catch(() => undefined)}
        >
          {copied ? <Check size={15} /> : <Copy size={15} />}
        </IconButton>
        <IconButton label="Open in browser" onClick={() => openExternally(currentHref)}>
          <ArrowUpRight size={15} />
        </IconButton>
        <IconButton label="Close preview" onClick={onClose}>
          <X size={15} />
        </IconButton>
      </div>

      <div className="link-peek-reader" ref={readerRef} hidden={inPage}>
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
