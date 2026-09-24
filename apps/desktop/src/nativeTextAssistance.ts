// WKWebView on macOS layers the system's text assistance — autocorrect,
// spellcheck underlines, auto-capitalisation, autofill and inline predictive
// suggestions — onto every editable element unless told otherwise per element.
// None of it belongs in an outliner, so every input, textarea and editable
// region is stamped as it enters the document.

export const TEXT_ASSISTANCE_OFF: Readonly<Record<string, string>> = {
  autocomplete: 'off',
  autocorrect: 'off',
  autocapitalize: 'off',
  spellcheck: 'false',
  writingsuggestions: 'false',
}

const EDITABLE_SELECTOR = 'input, textarea, [contenteditable]:not([contenteditable="false"])'

function disableOn(element: Element) {
  for (const [name, value] of Object.entries(TEXT_ASSISTANCE_OFF)) {
    if (element.getAttribute(name) !== value) element.setAttribute(name, value)
  }
}

function disableWithin(node: Node) {
  if (!(node instanceof Element)) return
  if (node.matches(EDITABLE_SELECTOR)) disableOn(node)
  node.querySelectorAll(EDITABLE_SELECTOR).forEach(disableOn)
}

export function disableNativeTextAssistance(root: Element = document.documentElement): () => void {
  disableWithin(root)
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'attributes') disableWithin(mutation.target)
      else mutation.addedNodes.forEach(disableWithin)
    }
  })
  // Watching contenteditable catches regions that become editable after mount.
  // The attributes stamped here are not observed, so stamping cannot loop.
  observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['contenteditable'] })
  return () => observer.disconnect()
}
