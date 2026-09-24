import { createRoot } from 'react-dom/client'
import { PeekHeaderWindow, peekHeaderHref } from './components/Outliner/PeekHeaderWindow'
import { disableNativeTextAssistance } from './nativeTextAssistance'
import './style.css'

disableNativeTextAssistance()

// The peek header window runs this same bundle under a hash route. It is a title
// bar with two buttons, and it holds none of the app's capabilities, so the app
// is imported lazily to keep its module graph — store, sidecar, outline — from
// being evaluated in a window that has no business booting it.
const peekHref = peekHeaderHref(window.location.hash)
const root = createRoot(document.getElementById('app')!)

if (peekHref) {
  root.render(<PeekHeaderWindow href={peekHref} />)
} else {
  void import('./App').then(({ default: App }) => root.render(<App />))
}
