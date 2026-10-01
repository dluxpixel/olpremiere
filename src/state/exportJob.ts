// The export, owned by the app instead of by the dialog that shows it.
//
// His words, 2026-09-28: *"Make it so that while the video is exporting, I can
// work on other videos too, because the export time is sometimes very long."*
//
// The encode used to live inside ExportDialog and was tied to its mount. The
// dialog covered the whole editor and refused to close while it ran, because
// closing it would have stopped the export. Here the job outlives the dialog:
// on the desktop the dialog can go away while the file is being made, a chip in
// the top bar keeps the percent in sight, and a toast says when it is done.
//
// THREE RULES MAKE THAT SAFE.
//
// 1. What is exported is FROZEN when he presses Export: a deep copy of the
//    project, not the live one. He is now free to edit, switch projects and
//    open other ones while it runs, and none of that may reach the file. The
//    Try again button reuses the same copy, so it makes the file he asked for.
// 2. The media that copy reads is HELD (exportHolds.ts), so deleting a project
//    or the orphan sweep cannot take the bytes out from under the encode.
// 3. ONE AT A TIME. Pressing Export while one runs opens the running one and
//    says so. A second ffmpeg would fight the first for the same machine, and
//    main keeps a single job slot, so a second start would strand the first.
//
// THE BROWSER PATH STAYS UP FRONT. On a phone the finished video goes to the
// share sheet, and a share has to come from a tap on the done screen, so that
// path keeps its dialog open to the end as it always did. It still runs from
// here, so there is one copy of the retry and of the result handling.

import { create } from 'zustand'
import { canStreamToDisk, exportSequence, pickExportDestination, type ExportProgress } from '../engine/export'
import { planExport, type ExportPlan } from '../engine/export/exportPlan'
import { PLATFORM_TARGET_LUFS } from '../engine/loudness'
import { exportNative } from '../engine/export/nativeExport'
import { activeSequence, type Project } from '../engine/types'
import { isElectron } from '../platform'
import { isPhoneLayout } from '../ui/phoneLayout'
import { holdBlobKeys } from './exportHolds'
import { setPlatformLoudness, useSettings } from './settings'
import { useStore } from './store'
import { useToasts } from './toasts'
import { beginCriticalWork } from './unloadGuard'

export type ExportStage =
  /** The browser's save picker is up; nothing is encoding yet. */
  | { kind: 'starting' }
  | { kind: 'running'; progress: ExportProgress; startedAt: number }
  /** `streamed` tells "written where you chose" apart from "in your downloads". */
  | { kind: 'done'; sizeBytes: number; fileName: string; streamed: boolean; path?: string; share?: File }
  | { kind: 'error'; message: string }

export interface ExportJob {
  /** New for every run, so a late callback from an older run changes nothing. */
  id: number
  /** The exported project's name, frozen with it: he may have opened another. */
  projectName: string
  plan: ExportPlan
  stage: ExportStage
  /** Desktop: the dialog may close while this runs. Browser: it stays up. */
  background: boolean
}

interface ExportJobState {
  job: ExportJob | null
  dialogOpen: boolean
  /** He pressed Export while this one was still going. */
  alreadyRunning: boolean
}

export const useExportJob = create<ExportJobState>(() => ({ job: null, dialogOpen: false, alreadyRunning: false }))

/** The frozen copy the current job reads, and the media keys it needs. */
let frozen: { project: Project; blobKeys: string[] } | null = null
let abort: AbortController | null = null
let nextJobId = 1
/** A plan to start the moment the running export has finished cancelling. */
let restartWith: ExportPlan | null = null

export const isExportActive = (stage: ExportStage): boolean => stage.kind === 'starting' || stage.kind === 'running'

/** Is an export being made right now? */
export function isExportRunning(): boolean {
  const { job } = useExportJob.getState()
  return !!job && isExportActive(job.stage)
}

/**
 * Is he looking at the export, rather than working while it runs? The preview
 * slows right down only while he is (Monitor.tsx).
 */
export const isExportWatched = (): boolean => useExportJob.getState().dialogOpen

export function exportPercent(stage: ExportStage): number {
  if (stage.kind !== 'running' || stage.progress.framesTotal <= 0) return 0
  return Math.min(100, Math.round((stage.progress.framesDone / stage.progress.framesTotal) * 100))
}

export function fmtBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GB`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`
  return `${Math.round(n / 1e3)} KB`
}

/** Letters and digits from any language stay, so a Czech name still names the file. */
const exportBaseName = (name: string): string => name.replace(/[^\p{L}\p{N}\-_ ]+/gu, '').trim() || 'export'

/** The media keys the active sequence reads. */
export function exportBlobKeys(project: Project): string[] {
  const seq = project.sequences[project.activeSequenceId]
  const keys = new Set<string>()
  for (const track of seq?.tracks ?? []) {
    for (const clip of track.clips) {
      const asset = project.assets[clip.assetId]
      if (asset) keys.add(asset.blobKey)
    }
  }
  return [...keys]
}

/** The specific GPU B-frame crash that a software retry fixes. */
function isBFrameCrash(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err)
  return /monotonically|Timestamps must be|\bDTS\b|B-?frame/i.test(m)
}

const isAbort = (err: unknown): boolean => err instanceof DOMException && err.name === 'AbortError'

const runningStage = (plan: ExportPlan): ExportStage => ({
  kind: 'running',
  progress: {
    phase: 'preparing',
    framesDone: 0,
    framesTotal: Math.ceil((plan.settings.endS - plan.settings.startS) * plan.settings.fps),
  },
  startedAt: performance.now(),
})

/** Change the job only if it is still run `id`. */
function patchJob(id: number, patch: (job: ExportJob) => Partial<ExportJob>): boolean {
  const { job } = useExportJob.getState()
  if (!job || job.id !== id) return false
  useExportJob.setState({ job: { ...job, ...patch(job) } })
  return true
}

function forgetJob(): void {
  frozen = null
  useExportJob.setState({ job: null, dialogOpen: false, alreadyRunning: false })
}

/**
 * The Export button. Freezes the project as it is at this moment and starts.
 * With one already running it opens that one instead and says so.
 */
export function requestExport(project: Project = useStore.getState().project): void {
  if (isExportRunning()) {
    useExportJob.setState({ dialogOpen: true, alreadyRunning: true })
    return
  }
  // A deep copy, not the live object. Edits replace the store's project rather
  // than change it, but "rather than" is a habit of the code, not a promise,
  // and the export takes minutes: one in-place write anywhere in that time
  // would change the file halfway through.
  const copy = structuredClone(project)
  frozen = { project: copy, blobKeys: exportBlobKeys(copy) }
  useExportJob.setState({ dialogOpen: true, alreadyRunning: false })
  void drive(planExport(activeSequence(copy), { platformLoudness: useSettings.getState().platformLoudness }))
}

/** Does this export bring the mix to the platforms' loudness? */
export const planHasPlatformLoudness = (plan: ExportPlan): boolean =>
  plan.settings.loudnessTargetLufs !== null && plan.settings.loudnessTargetLufs !== undefined

/**
 * The export window's "Platform loudness" switch. It remembers the choice for
 * the next export, and when an export is running with the other setting it
 * starts that one again from the same frozen copy, so the switch changes THIS
 * video, which is what it says it does.
 */
export function setExportLoudness(on: boolean): void {
  setPlatformLoudness(on)
  const { job } = useExportJob.getState()
  if (!job || !isExportActive(job.stage) || !frozen) return
  if (planHasPlatformLoudness(job.plan) === on) return
  restartWith = { ...job.plan, settings: { ...job.plan.settings, loudnessTargetLufs: on ? PLATFORM_TARGET_LUFS : null } }
  abort?.abort()
}

/** Run the failed export again, from the same frozen copy. */
export function retryExport(): void {
  const { job } = useExportJob.getState()
  if (!job || job.stage.kind !== 'error' || !frozen) return
  void drive(job.plan)
}

export function cancelExport(): void {
  // Cancel means stop, even right after the loudness switch asked for a restart.
  restartWith = null
  abort?.abort()
}

export function openExportDialog(): void {
  if (useExportJob.getState().job) useExportJob.setState({ dialogOpen: true, alreadyRunning: false })
}

/**
 * Close the dialog. On the desktop a running export carries on without it. In
 * the browser the save picker is the one point it may close early, and closing
 * there means no export; once encoding it stays up, as before.
 */
export function closeExportDialog(): void {
  const { job } = useExportJob.getState()
  if (job && isExportActive(job.stage)) {
    if (job.background) {
      useExportJob.setState({ dialogOpen: false, alreadyRunning: false })
      return
    }
    if (job.stage.kind !== 'starting') return
    cancelExport()
  }
  forgetJob()
}

async function drive(plan: ExportPlan): Promise<void> {
  const f = frozen
  if (!f) return
  const id = nextJobId++
  const ctrl = new AbortController()
  abort = ctrl
  const background = isElectron
  useExportJob.setState({
    job: {
      id,
      projectName: f.project.name,
      plan,
      background,
      stage: background ? runningStage(plan) : { kind: 'starting' },
    },
  })
  const release = holdBlobKeys(f.blobKeys)
  try {
    if (background) await runNative(id, f.project, plan, ctrl.signal)
    else await runBrowser(id, f.project, plan, ctrl.signal)
  } catch (err) {
    if (isAbort(err)) settleCancelled(id)
    else fail(id, err)
  } finally {
    release()
    if (abort === ctrl) abort = null
  }
  // Cancelled to start again with the other loudness setting: same frozen
  // copy, the new plan, and the dialog stays where it is. However the run
  // ended (a throw, or a browser picker that came back to a cancelled job),
  // a pending restart is taken here and only here.
  const again = restartWith
  if (again && ctrl.signal.aborted) {
    restartWith = null
    await drive(again)
  }
}

/** Cancelled, or the save dialog was dismissed: nothing to show. */
function settleCancelled(id: number): void {
  // A cancel that is really a restart keeps the job and its frozen copy.
  if (restartWith) return
  if (useExportJob.getState().job?.id === id) forgetJob()
}

function onProgress(id: number, progress: ExportProgress): void {
  const { job } = useExportJob.getState()
  if (!job || job.id !== id || job.stage.kind !== 'running') return
  useExportJob.setState({ job: { ...job, stage: { ...job.stage, progress } } })
}

function succeed(id: number, stage: Extract<ExportStage, { kind: 'done' }>): void {
  const { job, dialogOpen } = useExportJob.getState()
  if (!job || job.id !== id) return
  // Watching it: the done screen is where he is. Working elsewhere: the toast
  // is the whole news, so the job is finished with.
  if (dialogOpen) useExportJob.setState({ job: { ...job, stage } })
  else forgetJob()
  // He may be three edits into another project by now, so the toast carries the
  // way to the file rather than leaving him to go looking for it.
  const path = stage.path
  const api = typeof window !== 'undefined' ? window.api : undefined
  const reveal = path && api?.exportReveal ? () => void api.exportReveal(path) : null
  useToasts
    .getState()
    .show(
      `Export finished: ${stage.fileName} (${fmtBytes(stage.sizeBytes)})`,
      'success',
      reveal ? { label: 'Show in folder', onClick: reveal } : undefined,
    )
}

function fail(id: number, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  const name = useExportJob.getState().job?.projectName ?? ''
  if (!patchJob(id, () => ({ stage: { kind: 'error', message } }))) return
  // With the dialog open the error sits on it, with its own Try again. Closed,
  // he is in the middle of something else and has to be told here.
  if (!useExportJob.getState().dialogOpen) {
    useToasts.getState().show(`The export of “${name}” failed: ${message}`, 'danger', {
      label: 'Try again',
      onClick: retryExport,
    })
  }
}

// Desktop: render with the shared pipeline, encode with the bundled ffmpeg
// (x264 veryslow at constant quality, the best file this app can produce).
async function runNative(id: number, project: Project, plan: ExportPlan, signal: AbortSignal): Promise<void> {
  const baseName = exportBaseName(project.name)
  const endCritical = beginCriticalWork()
  try {
    const res = await exportNative(
      project,
      plan.settings,
      { encoder: plan.nativeEncoder, quality: plan.qp, suggestedName: `${baseName}.${plan.nativeExt}` },
      (p) => onProgress(id, p),
      signal,
    )
    // The save dialog was dismissed.
    if (res === null) {
      settleCancelled(id)
      return
    }
    const fileName = res.outPath.split(/[\\/]/).pop() || `${baseName}.${plan.nativeExt}`
    succeed(id, { kind: 'done', sizeBytes: res.sizeBytes, fileName, streamed: true, path: res.outPath })
  } finally {
    endCritical()
  }
}

async function runBrowser(id: number, project: Project, plan: ExportPlan, signal: AbortSignal): Promise<void> {
  const fileName = `${exportBaseName(project.name)}.mp4`
  let handle: FileSystemFileHandle | null = null
  // A phone has no save dialog worth the name: the finished video goes to the
  // share sheet instead, where "Save Video" puts it in Photos (see below).
  if (canStreamToDisk() && !isPhoneLayout()) {
    handle = await pickExportDestination(fileName)
    // Picker dismissed: there is nothing to export to, and nothing to show.
    if (!handle || signal.aborted) {
      settleCancelled(id)
      return
    }
  }

  const endCritical = beginCriticalWork()
  patchJob(id, () => ({ stage: runningStage(plan) }))
  try {
    const runExport = (hw: 'prefer-hardware' | 'prefer-software') =>
      exportSequence(project, { ...plan.settings, hardwareAcceleration: hw }, (p) => onProgress(id, p), signal, handle ?? undefined)

    // Constant quality pins the software encoder inside the worker; this
    // retry is for the VBR fallback, where some GPUs emit B-frames the muxer
    // cannot handle. It must escape hardware, never escalate into it.
    let blob: Blob | null
    try {
      blob = await runExport('prefer-hardware')
    } catch (err) {
      if (signal.aborted || !isBFrameCrash(err)) throw err
      patchJob(id, () => ({ stage: runningStage(plan) }))
      blob = await runExport('prefer-software')
    }

    // ON A PHONE THE VIDEO GOES TO PHOTOS (2026-09-23). A download on an
    // iPhone lands in the Files app, two apps away from where a Short gets
    // posted from. The share sheet has "Save Video", which puts it in Photos.
    // It needs a tap of its own (a share must come from a gesture), so the
    // file waits on the done screen for him to press Save to Photos.
    const shareFile = blob && isPhoneLayout() ? new File([blob], fileName, { type: 'video/mp4' }) : null
    const canShare = !!shareFile && typeof navigator.canShare === 'function' && navigator.canShare({ files: [shareFile] })
    if (blob && shareFile && canShare) {
      succeed(id, { kind: 'done', sizeBytes: blob.size, fileName, streamed: false, share: shareFile })
      return
    }
    let sizeBytes: number
    if (blob) {
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = fileName
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 30_000)
      sizeBytes = blob.size
    } else {
      sizeBytes = (await handle!.getFile()).size
    }
    succeed(id, { kind: 'done', sizeBytes, fileName: handle?.name ?? fileName, streamed: !!handle })
  } finally {
    endCritical()
  }
}
