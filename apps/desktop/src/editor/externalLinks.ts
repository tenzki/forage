// Click handling for external `link` marks.
//
// TipTap's own `openOnClick` handler calls `window.open(href, '_blank')`, which
// goes nowhere inside the Tauri webview under `default-src 'self'`. StarterKit is
// configured with `link: { openOnClick: false }` so this plugin owns the click
// instead: a plain click asks the app for an in-window page peek, and a
// modifier-click escapes to the real browser through the Tauri opener.
//
// Registered after `InternalLink` so `[[` links keep priority over this handler.

import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { openUrl } from '@tauri-apps/plugin-opener'
import { normalizedUrl } from '../components/Outliner/FormattingBubbleMenu'

export const OUTLINE_LINK_PEEK_EVENT = 'outline:link-peek'

const externalLinkPluginKey = new PluginKey('outlineExternalLinks')

/** Open a URL in the user's real browser, when the Tauri opener is available. */
export function openExternally(href: string): void {
  try {
    // `dev:web` has no IPC behind the plugin, so keep a browser fallback.
    void openUrl(href).catch(() => window.open(href, '_blank', 'noopener,noreferrer'))
  } catch {
    window.open(href, '_blank', 'noopener,noreferrer')
  }
}

export function requestLinkPeek(href: string): void {
  window.dispatchEvent(new CustomEvent(OUTLINE_LINK_PEEK_EVENT, { detail: { href } }))
}

export const ExternalLink = Extension.create({
  name: 'externalLink',

  addProseMirrorPlugins() {
    return [new Plugin({
      key: externalLinkPluginKey,
      props: {
        handleDOMEvents: {
          click: (_view, event) => {
            const anchor = event.target instanceof Element
              ? event.target.closest<HTMLAnchorElement>('a[href]')
              : null
            // Internal `[[` links carry their own handler and their own routing.
            if (!anchor || anchor.dataset.internalNodeId) return false

            let href: string
            try {
              href = normalizedUrl(anchor.getAttribute('href') ?? '')
            } catch {
              return false
            }

            event.preventDefault()
            // `mailto:` has no page to peek at, and a modifier-click is the
            // deliberate "take me to my real browser" gesture.
            if (href.startsWith('mailto:') || event.metaKey || event.ctrlKey) {
              openExternally(href)
            } else {
              requestLinkPeek(href)
            }
            return true
          },
        },
      },
    })]
  },
})
