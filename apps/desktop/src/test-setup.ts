// Test setup — polyfills for jsdom environment

// cmdk uses ResizeObserver internally
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}

// jsdom has no layout engine, so it never implements getClientRects on Range or
// on text nodes. ProseMirror calls both when it scrolls the selection into view.
const EMPTY_RECT = {
  top: 0,
  left: 0,
  bottom: 0,
  right: 0,
  width: 0,
  height: 0,
  x: 0,
  y: 0,
  toJSON: () => ({}),
} as DOMRect

const emptyRectList = () =>
  Object.assign([] as unknown as DOMRectList, { item: () => null })

const layoutPrototypes = typeof Range === 'undefined'
  ? []
  : [Range.prototype, Text.prototype, Element.prototype]

for (const proto of layoutPrototypes) {
  const target = proto as unknown as {
    getClientRects?: () => DOMRectList
    getBoundingClientRect?: () => DOMRect
  }
  if (typeof target.getClientRects !== 'function') {
    target.getClientRects = emptyRectList
  }
  if (typeof target.getBoundingClientRect !== 'function') {
    target.getBoundingClientRect = () => EMPTY_RECT
  }
}

// jsdom's scrollIntoView is unimplemented; ProseMirror calls it on selection changes.
if (typeof Element !== 'undefined' && typeof Element.prototype.scrollIntoView !== 'function') {
  Element.prototype.scrollIntoView = () => {}
}

// ProseMirror resolves click coordinates to a document position on mousedown.
if (typeof document !== 'undefined' && typeof document.elementFromPoint !== 'function') {
  document.elementFromPoint = () => null
}
