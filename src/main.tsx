import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { joinRoomFromUrl } from './collab/collabControl'
import { invalidatePreview } from './engine/preview'
import { loadTitleFonts } from './engine/render/titleFonts'
import './index.css'
import { loadDefaultTextAppearance } from './state/appearanceActions'
import { loadLibrary } from './state/library'
import { initPersistence } from './state/persistence'
import { initUpdateCheck } from './state/updateCheck'

initPersistence()
void loadLibrary()
// Register bundled title fonts (Minecraft/Monocraft) for the preview rasterizer,
// and hydrate the saved default text animation. Once the font lands, force a
// redraw so a reopened Minecraft title re-rasterizes off the real font.
void loadTitleFonts(document.fonts).then(invalidatePreview)
void loadDefaultTextAppearance()
// A shared room link (#room=...) auto-joins after the local project hydrates,
// so the joiner adopts the room state rather than racing it with a stale doc.
window.setTimeout(joinRoomFromUrl, 400)
// Nudge stale tabs after a deploy ("A new version is live — Reload").
initUpdateCheck()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
