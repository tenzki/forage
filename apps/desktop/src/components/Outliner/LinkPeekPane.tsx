// The link peek (Screen 08 in docs/desktop.pen): a reader pane beside the
// outline. It shows the page as clean reader text fetched through Jina Reader,
// lets the user clip a selection into the outline under the bullet that held
// the link, or ask an agent to summarize the page there. "Page" shows the live
// site in the same pane through a native webview laid over the page surface
// (see pagePeek.ts), since the app's CSP forbids framing remote origins.

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
  onPageState,
  openPage,
  pagePeekAvailable,
  setPageBounds,
  setPageVisible,
  type PageAction,
  type PageState,
} from './pagePeek'

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
  const [mode, setMode] = useState<PeekMode>('reader')
  const [page, setPage] = useState<PageState | null>(null)
  const [pageError, setPageError] = useState<string | null>(null)
  const readerRef = useRef<HTMLDivElement>(null)
  const pageRef = useRef<HTMLDivElement>(null)
  const pageLive = pagePeekAvailable()
  const skills = useSettingsStore((store) => store.skills)
  const href = history.entries[history.index]!

  // A new link from the outline starts a fresh history.
  useEffect(() => {
    setHistory({ entries: [openedHref], index: 0 })
  }, [openedHref])

  useEffect(() => {
    const controller = new AbortController()
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
    readerRef.current?.scrollTo({ top: 0 })
    return () => controller.abort()
  }, [href, reloadToken])

  // Show the live page over the page surface, or hide it while the reader is up.
  useEffect(() => {
    if (!pageLive) return
    const surface = pageRef.current
    if (mode !== 'page' || !surface) {
      void setPageVisible(false).catch(() => undefined)
      return
    }
    setPageError(null)
    setPage((current) => current && sameUrl(current.url, href) ? current : null)
    openPage(href, boundsOf(surface)).catch((error: unknown) => setPageError(errorMessage(error)))
  }, [mode, href, pageLive])

  // The page is a native view on top of this webview, so it has to follow the
  // pane as the layout moves, and step aside while a modal dialog is up.
  useEffect(() => {
    if (!pageLive || mode !== 'page') return undefined
    const surface = pageRef.current
    if (!surface) return undefined
    let frame = 0
    const sync = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        void setPageBounds(boundsOf(surface)).catch(() => undefined)
      })
    }
    let covered = false
    const checkModal = () => {
      const next = Boolean(document.querySelector('[aria-modal="true"]'))
      if (next === covered) return
      covered = next
      void setPageVisible(!covered).catch(() => undefined)
    }
    const resizes = new ResizeObserver(sync)
    resizes.observe(surface)
    const modals = new MutationObserver(checkModal)
    modals.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-modal'] })
    window.addEventListener('resize', sync)
    checkModal()
    return () => {
      cancelAnimationFrame(frame)
      resizes.disconnect()
      modals.disconnect()
      window.removeEventListener('resize', sync)
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
