import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { Boot } from './ui/BootSplash'
import { bootStep } from './ui/bootProgress'
import { bootTasks, runBootSequence, started, type BootWork } from './ui/bootSequence'
import { joinRoomFromUrl } from './collab/collabControl'
import { invalidatePreview, warmPreview } from './engine/preview'
import { warmAudio } from './engine/audio'
import { warmTranscriber } from './engine/captions/transcribe'
import { warmMusicModel } from './engine/captions/musicAnalysis'
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
import { activeSequence, type MediaAsset } from './engine/types'
import { useToasts } from './state/toasts'
import { initUpdateCheck } from './state/updateCheck'
import { initUpdateFeed, whenUpdateChecked } from './state/updateStatus'

// Every row the loading card shows is reported HERE, around the real calls, never
// from a timer in the UI. They run as ONE ordered sequence (see bootSequence.ts):
// one row at a time, top to bottom, each one settling before the next begins.
// That is what stops two rows running at once with a grey one stranded between
// them, and what stops a row that never answers parking the bar at 88% for ever.
//
// Work that does NOT need the project open is started the moment the settings
// land and is simply awaited when its row comes up, so the ordering is free.

/** Started early, reported in turn. Null only if the settings row itself threw. */
let libraryReady: Promise<void> | null = null
let fontsReady: Promise<void> | null = null
let transcriberReady: Promise<boolean> | null = null
/** The audio warm, started alongside the video warm and picked up by its own row. */
let audioWarm: Promise<number> | null = null

// WARM-UP. Everything below used to be paid on FIRST USE, in the middle of his
// work: the first play decoded the video, the first play and the first playhead
// scrub decoded the audio, and the first caption run loaded a model. His words,
// 2026-08-05: "why the hell would Sony Vegas and Adobe Premiere have such long
// loading times, right?" They are slow because they are doing this. The card was
// already holding a window open, so the work moves into it.
//
// Only what the OPEN PROJECT actually needs: warming the whole media library
// would punish a big library for no gain, since he can only play what is on the
// timeline.
function onTimeline(): MediaAsset[] {
  const project = useStore.getState().project
  const used = new Set(activeSequence(project).tracks.flatMap((t) => t.clips.map((c) => c.assetId)))
  return Object.values(project.assets).filter((a) => used.has(a.id))
}

/** Nothing to warm is a row that is DONE, not a row that hangs waiting for work. */
const readyDetail = (n: number): string => (n > 0 ? `${n} ready` : 'nothing to warm')

const work: BootWork = {
  settings: () => {
    // FIRST, before anything reads a setting: adopt the values that were saved
    // under the old `reel:` key names. Renaming a key does not move its data, so
    // without this the app boots as though the user had never set a preference
    // and had never saved a text or track preset.
    migrateRenamedKeys(localStorage)
    // Stamp the saved theme BEFORE React mounts: no flash of the wrong ground.
    // This row's work runs synchronously inside runBootSequence, which is what
    // keeps that true now that the settings live in the sequence with everything
    // else.
    initSettings()
    // None of these three needs the project, so queueing them behind it would
    // cost real seconds to buy nothing. Their rows report them in order below.
    libraryReady = started(loadLibrary())
    // Register the bundled title fonts (Minecraft/Monocraft) for the preview
    // rasterizer. Once the font lands, force a redraw so a reopened Minecraft
    // title re-rasterizes off the real font.
    fontsReady = started(loadTitleFonts(document.fonts).then(invalidatePreview))
    // The speech model is 75 to 100MB on a first ever run and lands in the
    // browser cache after that. Its row NEVER gates the card: an editor that will
    // not open until a model downloads is a far worse app than one that opens and
    // finishes behind him. On every boot after the first this is a fast cache
    // read, and his first caption run stops stalling.
    transcriberReady = started(warmTranscriber())
    // And the song classifier beside it, for exactly the same reason and on the
    // same terms: it never gates the card, it is a cache read after the first
    // boot, and it is the difference between his first caption run waiting on a
    // download and it already being there. Roughly 90 MB quantised.
    warmMusicModel()
  },
  project: async () => {
    await initPersistence()
    // A shared room link (#room=...) auto-joins only AFTER the local project
    // hydrates, because joining against the boot placeholder captures the wrong
    // preJoinProjectId and can seed/leak the wrong document into the room. It
    // belongs to THIS row because every row below reads the document a room join
    // swaps in. A join that FAILS is logged and stepped over rather than thrown
    // on: the local project did open, and the old chain answered a bad room link
    // by abandoning integrity, backups and both warm-up rows where they stood.
    await joinRoomFromUrl().catch((err: unknown) => {
      console.warn('OL Premiere boot: joining the shared room failed', err)
    })
  },
  media: () => libraryReady ?? started(loadLibrary()),
  fonts: () => fontsReady ?? started(loadTitleFonts(document.fonts).then(invalidatePreview)),
  integrity: async () => {
    // Only AFTER the document has hydrated, or an empty boot placeholder would
    // look exactly like the failure this is here to detect.
    const msg = integrityMessage(await checkIntegrity())
    if (msg) useToasts.getState().show(msg, 'danger')
  },
  // Start backing up once there is something worth backing up.
  backups: () => initAutoBackup(),
  warmVideo: async () => {
    const clips = onTimeline()
    // The audio decode starts HERE, with the video one: the two are independent,
    // and running them back to back would double the longest wait the card can be
    // asked to sit through. Only the REPORTING is one row at a time.
    audioWarm = started(warmAudio(clips))
    return { detail: readyDetail(await warmPreview(clips)) }
  },
  warmAudio: async () => ({ detail: readyDetail(await (audioWarm ?? started(warmAudio(onTimeline())))) }),
  updates: () => whenUpdateChecked((detail) => bootStep.note('updates', detail)),
  proxies: async () => {
    // The preview copies for what is on the timeline. The row says it is
    // happening; it never gates, because a multi-gigabyte import takes minutes to
    // transcode and the editor must open long before that.
    const { ensureProxies, proxyProgress, whenProxiesSettled } = await import('./engine/proxyMedia')
    ensureProxies(onTimeline())
    if (proxyProgress().queued === 0 && !proxyProgress().working) return { detail: 'nothing to prepare' }
    await whenProxiesSettled()
    const n = proxyProgress().done
    return { detail: n > 0 ? `${n} clip${n === 1 ? '' : 's'} ready` : undefined }
  },
  captions: async () => {
    const warm = await (transcriberReady ?? started(warmTranscriber()))
    // A model that will not load is a caption problem to be reported when he
    // actually asks for captions, not a reason to hold the app shut. It is still
    // said out loud here: a green tick for a model that is not there would be the
    // exact kind of decoration this card exists to avoid.
    return warm ? {} : { ok: false, detail: 'not ready' }
  },
}

const isElectron = typeof window !== 'undefined' && window.api?.isElectron === true
const booted = runBootSequence(bootTasks(work, isElectron))

// The desktop updater's state, pulled and watched. It drives both the card's
// "Checking for updates" row and the line under the melon. No-op on the web.
// Started right after the settings row so the network round trip overlaps the
// local startup; its ROW is reported in its own turn, further down the card.
initUpdateFeed()

void booted.then(() => {
  // Reclaim storage from media no project references any more. Deliberately AFTER
  // the whole startup ledger has settled and deliberately not awaited: it must
  // never delay the app opening, and it must never be able to fail the boot. Once
  // per session is plenty; the space only leaks when he deletes media.
  void import('./state/blobSweep').then((m) => m.sweepOrphanedBlobs())
})

// Hydrate the saved default text animation.
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
