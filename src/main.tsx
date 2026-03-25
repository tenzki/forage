import { createRoot } from 'react-dom/client'
import App from './App'
import './style.css'

// Disable right-click context menu
document.addEventListener('contextmenu', (e) => e.preventDefault())

createRoot(document.getElementById('app')!).render(<App />)
