import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { Boot } from './ui/BootSplash'
import { bootStep, trackBootStep, trackBootStepWith } from './ui/bootProgress'
import { joinRoomFromUrl } from './collab/collabControl'
import { invalidatePreview, warmPreview } from './engine/preview'
import { warmAudio } from './engine/audio'
import { warmTranscriber } from './engine/captions/transcribe'
import { loadTitleFonts } from './engine/render/titleFonts'
import './index.css'
import { loadDefaultTextAppearance } from './state/appearanceActions'
import { initAutoBackup } from './state/autoBackup'
import { checkIntegrity, integrityMessage } from './state/dataIntegrity'
import { migrateRenamedKeys } from './state/keyMigration'
import { loadLibrary } from './state/library'
import { initPersistence } from './state/persistence'
import { initSettings } from './state/settings'
import { useStore } from './state/store'
import { activeSequence } from './engine/types'
import { useToasts } from './state/toasts'
import { initUpdateCheck } from './state/updateCheck'
import { initUpdateFeed } from './state/updateStatus'

// Each `bootStep` call below is what the loading card shows. The rows exist to
// prove the work happened, so they are reported HERE, around the real calls,
// never from a timer in the UI.

// FIRST, before anything reads a setting: adopt the values that were saved under
// the old `reel:` key names. Renaming a key does not move its data, so without
// this the app boots as though the user had never set a preference and had never
// saved a text or track preset.
bootStep.begin('settings')
migrateRenamedKeys(localStorage)
// Stamp the saved theme BEFORE React mounts: no flash of the wrong ground.
initSettings()
bootStep.finish('settings')

// The desktop updater's state, pulled and watched. It drives both the card's
// "Checking for updates" row and the line under the melon. No-op on the web.
initUpdateFeed()

// A shared room link (#room=...) auto-joins only AFTER the local project
// hydrates, because joining against the boot placeholder captures the wrong
// preJoinProjectId and can seed/leak the wrong document into the room.
bootStep.begin('project')
void initPersistence()
  .then(() => {
    bootStep.finish('project')
  })
  .then(joinRoomFromUrl)
  .then(async () => {
    // Only AFTER the document has hydrated, or an empty boot placeholder would
    // look exactly like the failure this is here to detect.
    bootStep.begin('integrity')
    const msg = integrityMessage(await checkIntegrity())
    if (msg) useToasts.getState().show(msg, 'danger')
    bootStep.finish('integrity')
    // Start backing up once there is something worth backing up.
    bootStep.begin('backups')
    initAutoBackup()
    bootStep.finish('backups')

    // WARM-UP. Everything below used to be paid on FIRST USE, in the middle of
    // his work: the first play decoded the video, the first play and the first
    // playhead scrub decoded the audio, and the first caption run loaded a
    // model. His words, 2026-08-05: "why the hell would Sony Vegas and Adobe
    // Premiere have such long loading times, right?" They are slow because they
    // are doing this. The card was already holding a window open, so the work
    // moves into it.
    //
    // Only what the OPEN PROJECT actually needs: warming the whole media
    // library would punish a big library for no gain, since he can only play
    // what is on the timeline.
    const assets = Object.values(useStore.getState().project.assets)
    const used = new Set(
      activeSequence(useStore.getState().project).tracks.flatMap((t) => t.clips.map((c) => c.assetId)),
    )
    const onTimeline = assets.filter((a) => used.has(a.id))
    const readyDetail = (n: number): string => (n > 0 ? `${n} ready` : 'nothing to warm')
    await Promise.all([
      trackBootStepWith('warmVideo', warmPreview(onTimeline), readyDetail),
      trackBootStepWith('warmAudio', warmAudio(onTimeline), readyDetail),
    ])
  })
  .catch((err: unknown) => {
    // A broken startup must still open the app: mark whatever never landed as
    // failed so the card stops waiting on it, and let the editor come up.
    console.warn('OL Premiere boot: startup chain failed', err)
    bootStep.failUnfinished('project')
    bootStep.failUnfinished('integrity')
    bootStep.failUnfinished('backups')
    bootStep.failUnfinished('warmVideo')
    bootStep.failUnfinished('warmAudio')
  })

// The speech model is 75 to 100MB on a first ever run and lands in the browser
// cache after that. It is started HERE, off the project chain, and its row never
// gates the card: an editor that will not open until a model downloads is a far
// worse app than one that opens and finishes behind him. On every boot after the
// first this is a fast cache read, and his first caption run stops stalling.
void trackBootStep('captions', warmTranscriber())
void trackBootStep('media', loadLibrary())
// Register bundled title fonts (Minecraft/Monocraft) for the preview rasterizer,
// and hydrate the saved default text animation. Once the font lands, force a
// redraw so a reopened Minecraft title re-rasterizes off the real font.
void trackBootStep('fonts', loadTitleFonts(document.fonts).then(invalidatePreview))
void loadDefaultTextAppearance()
// Nudge stale tabs after a deploy ("A new version is live", with a Reload button).
initUpdateCheck()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Boot>
      <App />
    </Boot>
  </StrictMode>,
)
