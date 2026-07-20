import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { Boot } from './ui/BootSplash'
import { joinRoomFromUrl } from './collab/collabControl'
import { invalidatePreview } from './engine/preview'
import { loadTitleFonts } from './engine/render/titleFonts'
import './index.css'
import { loadDefaultTextAppearance } from './state/appearanceActions'
import { loadLibrary } from './state/library'
import { initPersistence } from './state/persistence'
import { initSettings } from './state/settings'
import { initUpdateCheck } from './state/updateCheck'

// Stamp the saved theme BEFORE React mounts: no flash of the wrong ground.
initSettings()

// A shared room link (#room=...) auto-joins only AFTER the local project
// hydrates — joining against the boot placeholder captures the wrong
// preJoinProjectId and can seed/leak the wrong document into the room.
void initPersistence().then(joinRoomFromUrl)
void loadLibrary()
// Register bundled title fonts (Minecraft/Monocraft) for the preview rasterizer,
// and hydrate the saved default text animation. Once the font lands, force a
// redraw so a reopened Minecraft title re-rasterizes off the real font.
void loadTitleFonts(document.fonts).then(invalidatePreview)
void loadDefaultTextAppearance()
// Nudge stale tabs after a deploy ("A new version is live — Reload").
initUpdateCheck()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Boot>
      <App />
    </Boot>
  </StrictMode>,
)
