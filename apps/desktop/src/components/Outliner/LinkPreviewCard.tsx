import {
  ArrowRight,
  ArrowUpRight,
  CircleSlash,
  Globe,
  Link as LinkIcon,
  Link2Off,
  PanelRightOpen,
  RotateCw,
} from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '../ui/Button'
import { Kbd } from '../ui/Kbd'

/** What the hover card is showing; see the `Link Preview/*` components in docs/desktop.pen. */
export type LinkPreviewModel =
  | {
      kind: 'external'
      href: string
      host: string
      status: 'loading' | 'ready' | 'error'
      title?: string
      description?: string
    }
  | {
      kind: 'internal'
      targetId: string
      path: string[]
      title: string
      children: string[]
      moreCount: number
      backlinkCount: number
    }
  | { kind: 'missing'; label: string }

export interface LinkPreviewActions {
  onPeek: () => void
  onOpenExternal: () => void
  onRetry: () => void
  onOpenInternal: () => void
  onRelink: () => void
  onRemoveLink: () => void
}

function FooterAction({ label, onClick, quiet = false, children }: {
  label?: string
  onClick: () => void
  quiet?: boolean
  children: ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      className={quiet ? 'link-card-action is-quiet' : 'link-card-action'}
      onMouseDown={(event) => event.preventDefault()}
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
    >
      {children}
    </button>
  )
}

function ExternalPreview({ model, actions }: {
  model: Extract<LinkPreviewModel, { kind: 'external' }>
  actions: LinkPreviewActions
}) {
  const unavailable = model.status === 'error'
  let address = model.href
  try {
    const url = new URL(model.href)
    address = `${url.hostname.replace(/^www\./u, '')}${url.pathname === '/' ? '' : url.pathname}`
  } catch {
    // Keep the raw href.
  }
  return (
    <>
      <div className="link-card-body">
        <span className="link-card-site">
          {/* No remote favicons: the app CSP allows only local images, so a monogram stands in. */}
          <span className={unavailable ? 'link-card-monogram is-unavailable' : 'link-card-monogram'} aria-hidden="true">
            {unavailable ? <Globe size={9} /> : model.host.slice(0, 1).toUpperCase()}
          </span>
          <span className="link-card-host">{model.host}</span>
        </span>
        {unavailable ? (
          <>
            <span className="link-card-url">{address}</span>
            <span className="link-card-notice"><CircleSlash size={12} aria-hidden="true" /> No preview — the site didn’t respond.</span>
          </>
        ) : (
          <>
            <span className="link-card-title">{model.title ?? (model.status === 'loading' ? 'Loading preview…' : model.host)}</span>
            {model.description && <span className="link-card-description">{model.description}</span>}
          </>
        )}
      </div>
      <div className="link-card-footer">
        {unavailable ? (
          <FooterAction onClick={actions.onRetry}><RotateCw size={12} aria-hidden="true" /> Retry</FooterAction>
        ) : (
          <FooterAction onClick={actions.onPeek}>
            <PanelRightOpen size={12} aria-hidden="true" /> Peek <Kbd>click</Kbd>
          </FooterAction>
        )}
        <FooterAction quiet label={`Open ${model.host} in browser`} onClick={actions.onOpenExternal}>
          Open in browser <ArrowUpRight size={12} aria-hidden="true" />
        </FooterAction>
      </div>
    </>
  )
}

function InternalPreview({ model, actions }: {
  model: Extract<LinkPreviewModel, { kind: 'internal' }>
  actions: LinkPreviewActions
}) {
  return (
    <>
      <div className="link-card-header">
        <span className="link-card-path">{model.path.length ? model.path.join('  ›  ') : 'Home'}</span>
        <span className="link-card-heading">{model.title || 'Untitled'}</span>
      </div>
      {model.children.length > 0 && (
        <ul className="link-card-children">
          {model.children.map((child, index) => <li key={index}>{child || 'Untitled'}</li>)}
          {model.moreCount > 0 && (
            <li className="link-card-more">+ {model.moreCount} more {model.moreCount === 1 ? 'bullet' : 'bullets'}</li>
          )}
        </ul>
      )}
      <div className="link-card-footer">
        <span className="link-card-backlinks">
          <LinkIcon size={12} aria-hidden="true" />
          {model.backlinkCount} linked {model.backlinkCount === 1 ? 'reference' : 'references'}
        </span>
        <FooterAction label={`Open ${model.title || 'Untitled'}`} onClick={actions.onOpenInternal}>
          Open <ArrowRight size={12} aria-hidden="true" />
        </FooterAction>
      </div>
    </>
  )
}

function MissingPreview({ model, actions }: {
  model: Extract<LinkPreviewModel, { kind: 'missing' }>
  actions: LinkPreviewActions
}) {
  return (
    <div className="link-card-missing">
      <span className="link-card-missing-title"><Link2Off size={14} aria-hidden="true" /> Linked bullet no longer exists</span>
      <p>“{model.label}” was deleted. Slash commands that reference it will stop before running.</p>
      <div className="link-card-missing-actions">
        <Button size="sm" onMouseDown={(event) => event.preventDefault()} onClick={(event) => { event.stopPropagation(); actions.onRelink() }}>Relink…</Button>
        <Button size="sm" onMouseDown={(event) => event.preventDefault()} onClick={(event) => { event.stopPropagation(); actions.onRemoveLink() }}>Remove link</Button>
      </div>
    </div>
  )
}

export function LinkPreviewCard({ model, actions }: { model: LinkPreviewModel; actions: LinkPreviewActions }) {
  if (model.kind === 'internal') return <InternalPreview model={model} actions={actions} />
  if (model.kind === 'missing') return <MissingPreview model={model} actions={actions} />
  return <ExternalPreview model={model} actions={actions} />
}
