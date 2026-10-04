// The shared IPC type surface between the Electron main process, the sandboxed
// preload, and the renderer (via electron-api.d.ts).

export type NativeEncoder = 'x264' | 'x265' | 'nvenc-h264' | 'nvenc-hevc' | 'nvenc-av1' | 'prores' | 'lossless'

export interface NativeCaps {
  ok: boolean
  encoders: string[]
  nvenc: { h264: boolean; hevc: boolean; av1: boolean }
}

export interface NativeExportConfig {
  width: number
  height: number
  fps: number
  totalFrames: number
  encoder: NativeEncoder
  /** QP/CRF on the 0 to 51 scale (used by x264/x265/nvenc; ignored by prores/lossless). */
  quality: number
  /**
   * The longest the encoder may go without a keyframe, in seconds. Carried from
   * the plan (exportPlan.ts EXPORT_KEYFRAME_S) rather than restated here, so this
   * path and the WebCodecs path key at the same cadence. Absent falls back to the
   * same 2 seconds keyframeStride() defaults to.
   */
  keyframeIntervalS?: number
  hasAudio: boolean
  /** When set, skip the save dialog (used by re-export / tests). */
  outPath?: string
  suggestedName: string
}

export interface NativeStartResult {
  started: boolean
  outPath?: string
  cancelled?: boolean
  error?: string
}

export interface NativeFinishResult {
  ok: boolean
  outPath?: string
  sizeBytes?: number
  error?: string
}

export interface NativeProgress {
  frame: number
  totalFrames: number
}

/**
 * Where the auto-updater stands right now. Sent on every transition AND readable
 * on demand, because the check starts when the app is ready, which can be before
 * the renderer exists. A renderer that only subscribed would miss that answer and
 * sit on "Checking…" forever, which is the silence that hid a dead feed for weeks.
 */
export type UpdateStatus =
  | { kind: 'checking' }
  | { kind: 'available'; version: string }
  /**
   * `transferred` and `total` are bytes, and they are OPTIONAL so nothing that
   * already reads this type has to change. electron-updater hands them over on the
   * same event it takes `percent` from and they were being thrown away; carrying
   * them is what lets the update card print "112 of 240 MB" instead of a bare
   * percent that names no denominator.
   */
  | { kind: 'downloading'; version: string; percent: number; transferred?: number; total?: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'none' }
  | { kind: 'error'; message: string }
  /** Unpackaged/dev build: no updater runs, so there is nothing to report. */
  | { kind: 'unsupported' }

/**
 * The splash window's choreography, in ONE place because three files have to
 * agree on it: the splash page animates it, the main process resizes and swaps
 * windows on it, and `splashTiming.test.ts` checks the stylesheet still matches.
 * A number that drifted here used to mean a card that vanished before its
 * animation finished, or a melon that popped into an already-closed window.
 */
/** The loading card's exit, before the window shrinks. Matches `.card.leaving` in splash.css. */
export const SPLASH_CARD_EXIT_MS = 300
/** The melon's pop on click. The splash outlives the swap by exactly this, so the fruit bursts OVER the opening editor. */
export const SPLASH_MELON_POP_MS = 420
/** The square the splash shrinks to once the melon is the only thing left in it. */
export const SPLASH_MELON_PX = 360
/**
 * The splash WINDOW, in the one place both the window and the card can be read
 * from. Sized to the card plus room for the drop shadow to land on a transparent
 * background. It was still 700 by 344 on 2026-08-09, the size of the seven-row
 * card of v0.1.16, by which point the startup had eleven rows and the card was
 * being cut off top and bottom inside its own window.
 */
export const SPLASH_WINDOW_W = 700
export const SPLASH_WINDOW_H = 460

/**
 * The UPDATE card's choreography, here for the same reason the splash block above
 * is here: main opens the window, the page animates it, and a test asserts the
 * stylesheet still agrees. His ask, 2026-08-24: *"when its downloading it does a
 * downloading screen similiar to the opening of the app screen."*
 */
/**
 * How long a download must have been running before the window opens. A small
 * delta finishes in under a second, and a 700x460 always-on-top window that
 * flashed for it would be worse than no window at all.
 */
export const UPDATE_SCREEN_DELAY_MS = 900
/**
 * Past this, the download is nearly done and the card would open only to leave.
 * The toast already carries a finished update.
 */
export const UPDATE_SCREEN_MAX_PCT = 90
/**
 * How long the card stands on its LAST frame, downloaded or failed, before it
 * goes. One sentence has to be readable; a card that vanished on the beat it
 * finished would have said nothing at all.
 */
export const UPDATE_CARD_HOLD_MS = 1600
/**
 * No progress and no answer for this long: the card leaves, quietly. The window is
 * frameless, skipTaskbar and always-on-top with no close button, so it must never
 * be able to sit at 63% forever with Escape as its only undocumented exit.
 */
export const UPDATE_STALL_MS = 90_000
/**
 * How long the melon waits to be clicked before the window closes itself. The boot
 * melon waits forever because nothing else is on screen; this one is sitting on top
 * of his timeline, and the update installs itself at the next start either way.
 */
export const UPDATE_MELON_TIMEOUT_MS = 20_000
/**
 * Twentieths of one file. ⛔ MUST DIVIDE 100, or the last segment cannot light at
 * 100% and the bar reads full at 95, which is the boot bar's old lie in a new shape.
 */
export const UPDATE_BAR_SEGMENTS = 20
/**
 * ⛔ A RECOMMENDATION, AND A SWITCH. False: the card opens only for a check HE
 * started with the melon.
 *
 * Two of the three routes into `downloading` are unbidden, the check at app-ready
 * and the fifteen minute poll, so without this the card appears a second after
 * every launch and again mid-afternoon over his timeline, asked for by nobody. He
 * asked for a screen WHEN HE CLICKS THE MELON. The unbidden case is already
 * narrated: the topbar mark takes the bite and the toast fires either way.
 */
export const UPDATE_SCREEN_UNBIDDEN = false

/**
 * Why CutStudio could not cut a pasted picture out. The renderer turns each one
 * into its own plain sentence, because "it failed" would leave him guessing
 * whether to install something, wait a moment, or just keep the background.
 */
export type CutoutFailure =
  /** No cutstudio.exe in any place we know to look. */
  | 'not-found'
  /** It was found and started, and it quit before it ever answered. */
  | 'no-start'
  /** It started and has not answered yet. The first start loads a model. */
  | 'slow-start'
  /** Something that is not CutStudio answers on its port. */
  | 'port-taken'
  /** CutStudio runs, but has no cutout model downloaded yet. */
  | 'no-model'
  /** CutStudio answered and could not do this picture. */
  | 'failed'

/** A pasted picture sent through CutStudio: PNG bytes with a see-through background, or why not. */
export type CutoutResult =
  | { ok: true; png: ArrayBuffer }
  | { ok: false; reason: CutoutFailure; detail: string }

/** One frame of the loading card's state, sent to the splash window. */
export interface BootProgress {
  /** `optional` is a row the app does not wait for. The splash draws those apart. */
  rows: { id: string; label: string; state: 'pending' | 'active' | 'done' | 'failed'; optional?: boolean }[]
  line: string
  percent: number
  /**
   * How many rows that HOLD THE APP SHUT have settled, out of how many there are.
   * Counted once, by the editor (`gatingCount`), and sent, rather than recounted in
   * the splash: the desktop card and the in-app card must never be able to disagree
   * about how full the bar is.
   */
  settled: number
  total: number
  version: string
}

export interface OlApi {
  /** Always true when running inside the desktop shell (the renderer's isElectron gate). */
  readonly isElectron: true
  getVersion(): Promise<string>
  /** Which native encoders this machine's bundled ffmpeg + GPU actually offer. */
  nativeProbe(): Promise<NativeCaps>
  /** Write the rendered audio mix (a full WAV) to a temp file BEFORE starting (it's an ffmpeg input). */
  nativePrepareAudio(wav: ArrayBuffer): Promise<{ ok: boolean }>
  /** Pick a destination (or use config.outPath) and spawn ffmpeg. */
  nativeStart(config: NativeExportConfig): Promise<NativeStartResult>
  /** Stream one raw RGBA frame to ffmpeg; resolves when it's accepted (backpressure). */
  nativeWriteFrame(frame: ArrayBuffer): Promise<{ ok: boolean; error?: string }>
  /** Close the stream, wait for ffmpeg to finish, return the result. */
  nativeFinish(): Promise<NativeFinishResult>
  /** Abort + clean up a partial file. */
  nativeCancel(): Promise<void>
  /**
   * Build a short-GOP preview copy of a video, so the preview can jump around
   * it instantly. Both directions stream in chunks: his captures are gigabytes,
   * and ⛔ **a preview copy is NOT small.** Measured on his own 1.37 GB capture,
   * 2026-08-22: the copy is 423 MB, because a keyframe every twelve frames on
   * sixty frame footage is five keyframes a second at full size.
   * `proxyFinish` resolves to null when no copy could be made, and the preview
   * then reads the original exactly as it did before proxies existed.
   * `proxyRelease` must be called either way, or a temp stays on his drive.
   */
  /**
   * His media as real files, mirrored OUTSIDE IndexedDB and keyed by asset id.
   *
   * ⛔ ON 2026-08-18 THE DATABASE THREW ITSELF AWAY AND TOOK THE ONLY COPY OF HIS
   * FOOTAGE WITH IT. The bytes were still on his disk in Chromium's blob folder
   * and nothing was left able to name them, so forty four cuts pointed at video
   * the app could not reach and he stopped opening it for five days. This folder
   * is the second home a rebuild cannot touch: written on import, read back when
   * the database has lost its copy.
   */
  mediaList(): Promise<{ dir: string; error?: string; files: { id: string; size: number }[] }>
  mediaBegin(id: string): Promise<boolean>
  mediaChunk(id: string, bytes: ArrayBuffer): Promise<void>
  mediaFinish(id: string): Promise<number>
  mediaCancel(id: string): Promise<void>
  mediaRead(id: string, offset: number, length: number): Promise<ArrayBuffer | null>
  mediaDelete(id: string): Promise<void>
  proxyBegin(): Promise<string>
  proxyChunk(id: string, bytes: ArrayBuffer): Promise<void>
  proxyFinish(id: string): Promise<{ size: number } | null>
  proxyRead(id: string, offset: number, length: number): Promise<ArrayBuffer>
  proxyRelease(id: string): Promise<void>
  /**
   * Convert a recording Chromium cannot open (his OBS .mkv) into an MP4, once,
   * on import. The video is COPIED, so this is a container change at disk speed
   * and not a re-encode.
   *
   * ⛔ THE RESULT IS READ BACK IN CHUNKS, unlike a proxy. A proxy is small by
   * construction; this is a lossless copy of his source, so a 6 GB capture comes
   * back as 6 GB and returning it whole would need it in memory twice.
   * `remuxRelease` must be called when the read is done, or a full sized temp
   * stays on a drive that is already nearly full.
   */
  remuxBegin(): Promise<string>
  remuxChunk(id: string, bytes: ArrayBuffer): Promise<void>
  /**
   * `mode` is why the conversion is happening, and it changes what ffmpeg does.
   * 'convert' is the up-front path for containers Chromium cannot demux at all
   * (his OBS .mkv), and it COPIES the video. 'rescue' runs after a real decode
   * failure, so it re-encodes to H.264: copying would hand the same codec back
   * to the decoder that just refused it. 'sdr' makes the SDR master of an HDR
   * phone clip (remuxArgs.ts), and a rescue of an HDR clip does the same.
   */
  remuxFinish(
    id: string,
    mode?: 'convert' | 'rescue' | 'sdr',
  ): Promise<{ size: number; copied: boolean; durationS: number }>
  remuxRead(id: string, offset: number, length: number): Promise<ArrayBuffer>
  remuxRelease(id: string): Promise<void>
  /** How far a re-encoding `remuxFinish` has got, 0 to 1, by job id. Returns an unsubscribe fn. */
  onRemuxProgress(cb: (id: string, frac: number) => void): () => void
  /** Encode progress (frame/totalFrames) parsed from ffmpeg. Returns an unsubscribe fn. */
  onNativeProgress(cb: (p: NativeProgress) => void): () => void
  /** Fires when a newer version has downloaded and is staged to install on restart. Returns an unsubscribe fn. */
  onUpdateReady(cb: (version: string) => void): () => void
  /**
   * Fires when an update is downloaded and he has stepped away, and main wants
   * to apply it NOW, but the renderer arbitrates: it flushes a save and restarts
   * only if no critical work (e.g. an export) is in flight, else it defers to the
   * "Restart to update" toast. Returns an unsubscribe fn.
   */
  onAutoApplyUpdate(cb: (version: string) => void): () => void
  /** Fires when an update CHECK or download fails (404 feed, offline, bad yml). Returns an unsubscribe fn. */
  onUpdateError(cb: (message: string) => void): () => void
  /** Fires when the check succeeded and the app is already newest. Returns an unsubscribe fn. */
  onUpdateNone(cb: () => void): () => void
  /** Quit and install the downloaded update now. Relaunches into the new version. */
  restartToUpdate(): void
  /**
   * Tell main that a restart right now would destroy something: an in-browser
   * export, a live microphone, a take waiting to be kept. Main cannot see any of
   * those, so without this it would keep offering to relaunch mid take.
   */
  setUpdateBusy(on: boolean): void
  /** The updater's CURRENT state, pullable, so a late renderer still learns the answer. */
  getUpdateStatus(): Promise<UpdateStatus>
  /**
   * Check for an update NOW. Runs in main, which outlives a renderer reload, so the
   * reload button can ask and then reload without cutting its own check short.
   */
  /** Real machine memory in KB, so the caches can be sized against it. */
  systemMemory(): Promise<{ totalKb: number; freeKb: number }>
  checkForUpdates(): Promise<void>

  /** Editor renderer to main: what the loading card would be showing right now. */
  reportBootProgress(progress: BootProgress): void
  /**
   * Editor renderer to main: the startup work is done. This does NOT open the
   * editor. The splash drops its card and puts up the melon, and HE opens the app
   * by clicking it.
   */
  bootFinished(): void
  /** Splash window only: every progress update, forwarded from the editor. */
  onBootProgress(cb: (progress: BootProgress) => void): () => void
  /** Splash window only: the startup work is done, so play the card out and show the melon. */
  onBootReady(cb: () => void): () => void
  /** Splash to main: the card is gone, shrink the window around the melon. */
  splashShrink(): void
  /** Splash to main: the melon was clicked, open the editor. */
  splashEnter(): void

  /** Update window only: the card has painted, so it is safe to show. */
  updateShow(): void
  /** Update window to main: the card is gone, shrink the window around the melon. */
  updateShrink(): void
  /**
   * Update window to main: the melon was clicked, restart into the new version.
   *
   * ⛔ NOT `update:install`. This routes into the renderer's existing decision, so
   * it can never quit through an in-flight export or an unsaved edit.
   */
  updateApply(): void
  /** Update window to main: nothing more to say, close me. */
  updateDismiss(): void
  /** Every updater transition: checking → available → downloading → downloaded / none / error. Returns an unsubscribe fn. */
  onUpdateStatus(cb: (status: UpdateStatus) => void): () => void

  /** One automatic backup of the project DOCUMENT to a plain file. Returns its path. */
  backupWrite(projectName: string, json: string): Promise<string>
  /** Newest first. */
  backupList(): Promise<BackupEntry[]>
  /** The folder backups live in, for showing the user where their safety net is. */
  backupDir(): Promise<string>
  /** Read one back for restoring. Only paths inside the backup folder are allowed. */
  backupRead(filePath: string): Promise<string>
  /** Open the backup folder in Explorer. */
  backupReveal(): Promise<void>
  /** Open Explorer with the exported file selected, so he can find what he just made. */
  exportReveal(filePath: string): Promise<void>

  /**
   * The project as a plain file, kept current on every save (electron/projectFiles.ts).
   * The browser store is a cache of these; when it is gone, these are the store.
   */
  projectWrite(id: string, projectName: string, json: string): Promise<string>
  /** Every project file, newest first, one per project id. */
  projectList(): Promise<ProjectFileEntry[]>
  /** Read one back. Only paths inside the project folder are allowed. */
  projectRead(filePath: string): Promise<string>
  /** His delete: the file moves into Trash, it is never unlinked. */
  projectTrash(id: string): Promise<number>
  /** The folder, for telling him where his projects are. */
  projectDir(): Promise<string>

  /**
   * The Library's records as one plain file beside the projects, kept current
   * on every Library change (electron/libraryFile.ts). Its media bytes are in
   * the spare-copy folder under `lib-<item id>`.
   */
  libraryWrite(json: string): Promise<void>
  /** The file's text, or null when there is none yet. */
  libraryRead(): Promise<string | null>

  /**
   * His saved caption styles and which one new captions use, as one plain file
   * beside the projects, kept current on every change
   * (electron/captionStylesFile.ts).
   */
  captionStylesWrite(json: string): Promise<void>
  /** The file's text, or null when there is none yet. */
  captionStylesRead(): Promise<string | null>

  /**
   * The private usage log (electron/usageFiles.ts): append one day's batch of JSON
   * lines to that day's file in the app's own data folder. Never leaves the machine.
   * `day` is `YYYY-MM-DD`; anything else is refused.
   */
  usageAppend(day: string, lines: string): Promise<void>
  /** The folder the usage log lives in, for telling him where it is. */
  usageDir(): Promise<string>
  /** Open that folder in Explorer. */
  usageReveal(): Promise<void>

  /**
   * A save dialog in his last folder for this kind of file, suggesting a name
   * nothing there has (`_1`, `_2`, never a replace prompt). Null when cancelled.
   */
  pickSavePath(kind: 'export' | 'project', base: string, ext: string, filterName: string): Promise<string | null>
  /** Open a path he just picked for writing. Any other path is refused. */
  fileOpenWrite(target: string): Promise<number>
  fileWriteChunk(id: number, chunk: ArrayBuffer): Promise<void>
  /** `ok` false throws the partial file away instead of keeping it. */
  fileClose(id: number, ok: boolean): Promise<void>

  /**
   * Cut a pasted picture out with CutStudio, his own offline background remover
   * (electron/cutstudio.ts). Main starts CutStudio's local server when nothing is
   * listening and stops it again when the app quits.
   */
  removeBackground(bytes: ArrayBuffer, mime: string): Promise<CutoutResult>
}

export interface ProjectFileEntry {
  id: string
  name: string
  path: string
  updatedAt: number
  sizeBytes: number
}

export interface BackupEntry {
  name: string
  path: string
  sizeBytes: number
  modifiedMs: number
}
