import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'
import { loadLibrary } from './state/library'
import { initPersistence } from './state/persistence'

initPersistence()
void loadLibrary()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
