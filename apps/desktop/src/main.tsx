/// <reference types="vite/client" />
import { createRoot } from 'react-dom/client'
import { disableNativeTextAssistance } from './nativeTextAssistance'
import { initializeTheme } from './themeCache'
import './style.css'

initializeTheme()
disableNativeTextAssistance()

const root = createRoot(document.getElementById('app')!)

if (import.meta.env.DEV && window.location.hash === '#two-view-prototype') {
  void import('./editor/prototypes/TwoViewPrototype').then(({ TwoViewPrototype }) => root.render(<TwoViewPrototype />))
} else if (import.meta.env.DEV && window.location.hash === '#ui-kit') {
  // Development-only catalogue of the shared UI components.
  void import('./components/ui/UiGallery').then(({ UiGallery }) => root.render(<UiGallery />))
} else {
  void import('./App').then(({ default: App }) => root.render(<App />))
}
