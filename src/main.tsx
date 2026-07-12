import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { invalidatePreview } from './engine/preview'
import { loadTitleFonts } from './engine/render/titleFonts'
import './index.css'
import { loadDefaultTextAppearance } from './state/appearanceActions'
import { loadLibrary } from './state/library'
import { initPersistence } from './state/persistence'

initPersistence()
void loadLibrary()
// Register bundled title fonts (Minecraft/Monocraft) for the preview rasterizer,
// and hydrate the saved default text animation. Once the font lands, force a
// redraw so a reopened Minecraft title re-rasterizes off the real font.
void loadTitleFonts(document.fonts).then(invalidatePreview)
void loadDefaultTextAppearance()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
