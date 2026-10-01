/**
 * @vitest-environment jsdom
 *
 * THE EXPORT THAT KEEPS GOING WHILE HE WORKS.
 *
 * His words, 2026-09-28: *"Make it so that while the video is exporting, I can
 * work on other videos too, because the export time is sometimes very long."*
 *
 * The encoders are stood in for, so what is proven here is the controller's
 * own promises: the file is made from the project as it was when he pressed
 * Export, only one runs at a time, a cancel really stops it, and he hears how
 * it ended even with the dialog closed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activeSequence, newProject, type Clip, type Project } from '../engine/types'
import type { ExportProgress, ExportSettings } from '../engine/export/messages'
import { isBlobHeld } from './exportHolds'
import {
  cancelExport,
  closeExportDialog,
  isExportRunning,
  requestExport,
  retryExport,
  setExportLoudness,
  useExportJob,
} from './exportJob'
import { PLATFORM_TARGET_LUFS } from '../engine/loudness'
import { setPlatformLoudness, useSettings } from './settings'
import { useStore } from './store'
import { useToasts } from './toasts'
import { isCriticalWorkInFlight } from './unloadGuard'

interface NativeCall {
  project: Project
  settings: ExportSettings
  onProgress: (p: ExportProgress) => void
  signal: AbortSignal
  resolve: (r: { outPath: string; sizeBytes: number } | null) => void
  reject: (err: unknown) => void
}

const h = vi.hoisted(() => ({
  electron: true,
  native: [] as NativeCall[],
  browser: [] as { project: Project; settings: ExportSettings }[],
  browserResults: [] as (() => Promise<Blob | null>)[],
  picker: null as null | (() => Promise<unknown>),
}))

vi.mock('../platform', () => ({
  get isElectron() {
    return h.electron
  },
  olApi: undefined,
}))

vi.mock('../engine/export/nativeExport', () => ({
  exportNative: (
    project: Project,
    settings: ExportSettings,
    _opts: unknown,
    onProgress: (p: ExportProgress) => void,
    signal: AbortSignal,
  ) =>
    new Promise((resolve, reject) => {
      h.native.push({ project, settings, onProgress, signal, resolve, reject })
      // The real one rejects with AbortError once ffmpeg is told to stop.
      signal.addEventListener('abort', () => reject(new DOMException('Export cancelled', 'AbortError')))
    }),
}))

vi.mock('../engine/export', () => ({
  canStreamToDisk: () => true,
  pickExportDestination: () => (h.picker ? h.picker() : Promise.resolve(null)),
  exportSequence: (project: Project, settings: ExportSettings) => {
    h.browser.push({ project, settings })
    const next = h.browserResults.shift()
    return next ? next() : Promise.resolve(null)
  },
}))

const flush = () => new Promise((r) => setTimeout(r, 0))

/** A project with one clip on V1, reading media key `blobKey`. */
function projectWithClip(name: string, blobKey: string): Project {
  const p = newProject(name)
  const seq = activeSequence(p)
  p.assets = {
    a1: { id: 'a1', name: 'clip.mp4', kind: 'video', blobKey, durationS: 5 } as Project['assets'][string],
  }
  seq.durationS = 5
  seq.tracks[0].clips = [
    { id: 'c1', assetId: 'a1', startS: 0, inS: 0, outS: 5, speed: 1, enabled: true } as unknown as Clip,
  ]
  return p
}

let revealed: string[] = []

beforeEach(() => {
  h.electron = true
  h.native.length = 0
  h.browser.length = 0
  h.browserResults.length = 0
  h.picker = null
  revealed = []
  ;(window as unknown as { api: unknown }).api = {
    isElectron: true,
    exportReveal: (p: string) => {
      revealed.push(p)
      return Promise.resolve()
    },
  }
  useToasts.setState({ toasts: [] })
  useStore.getState().setProject(projectWithClip('Holiday', 'asset/holiday'))
})

afterEach(async () => {
  setPlatformLoudness(true)
  cancelExport()
  await flush()
  useExportJob.setState({ job: null, dialogOpen: false, alreadyRunning: false })
  delete (window as unknown as { api?: unknown }).api
})

describe('what is exported is frozen when he presses Export', () => {
  it('later edits, a project switch and a write into the old object never reach the file', () => {
    const pressed = useStore.getState().project
    requestExport()
    expect(h.native).toHaveLength(1)
    const exported = h.native[0].project
    // A copy, not the live object.
    expect(exported).not.toBe(pressed)

    // He keeps working: renames it, clears the timeline in place, then opens
    // another project entirely.
    useStore.getState().dispatch('Rename project', (p) => ({ ...p, name: 'Renamed' }))
    pressed.name = 'Written in place'
    activeSequence(pressed).tracks[0].clips.length = 0
    useStore.getState().setProject(newProject('Something else'))

    expect(exported.name).toBe('Holiday')
    expect(activeSequence(exported).tracks[0].clips).toHaveLength(1)
    // The chip names the project being exported, not the one now on screen.
    expect(useExportJob.getState().job?.projectName).toBe('Holiday')
  })

  it('holds the media it reads while it runs, and lets go when it ends', async () => {
    requestExport()
    expect(isBlobHeld('asset/holiday')).toBe(true)
    expect(isCriticalWorkInFlight()).toBe(true)

    h.native[0].resolve({ outPath: 'C:\\Videos\\Holiday.mp4', sizeBytes: 2_000_000 })
    await flush()
    expect(isBlobHeld('asset/holiday')).toBe(false)
    expect(isCriticalWorkInFlight()).toBe(false)
  })
})

describe('one export at a time', () => {
  it('pressing Export while one runs shows that one and starts nothing', () => {
    requestExport()
    closeExportDialog()
    useStore.getState().setProject(projectWithClip('Second', 'asset/second'))

    requestExport()
    expect(h.native).toHaveLength(1)
    const s = useExportJob.getState()
    expect(s.dialogOpen).toBe(true)
    expect(s.alreadyRunning).toBe(true)
    expect(s.job?.projectName).toBe('Holiday')
  })

  it('once it is done, Export starts the next one', async () => {
    requestExport()
    h.native[0].resolve({ outPath: 'C:\\Videos\\Holiday.mp4', sizeBytes: 1 })
    await flush()
    closeExportDialog()

    requestExport()
    expect(h.native).toHaveLength(2)
  })
})

describe('cancel', () => {
  it('stops the export, clears it, and lets go of everything it held', async () => {
    requestExport()
    closeExportDialog()
    cancelExport()
    expect(h.native[0].signal.aborted).toBe(true)
    await flush()

    expect(useExportJob.getState().job).toBeNull()
    expect(isExportRunning()).toBe(false)
    expect(isBlobHeld('asset/holiday')).toBe(false)
    expect(isCriticalWorkInFlight()).toBe(false)
    expect(useToasts.getState().toasts).toHaveLength(0)
  })
})

describe('closing the dialog while it runs', () => {
  it('keeps a desktop export going', () => {
    requestExport()
    closeExportDialog()
    expect(useExportJob.getState().dialogOpen).toBe(false)
    expect(h.native[0].signal.aborted).toBe(false)
    expect(isExportRunning()).toBe(true)
  })
})

describe('how it ended, told with the dialog closed', () => {
  it('a finished export says so, with Show in folder', async () => {
    requestExport()
    closeExportDialog()
    h.native[0].resolve({ outPath: 'C:\\Videos\\Holiday 2.mp4', sizeBytes: 5_000_000 })
    await flush()

    const [toast] = useToasts.getState().toasts
    expect(toast.message).toBe('Export finished: Holiday 2.mp4 (5.0 MB)')
    expect(toast.kind).toBe('success')
    expect(toast.action?.label).toBe('Show in folder')
    toast.action!.onClick()
    expect(revealed).toEqual(['C:\\Videos\\Holiday 2.mp4'])
    // Nothing left to show: the toast was the news.
    expect(useExportJob.getState().job).toBeNull()
  })

  it('a failure says so, and Try again makes the same frozen project again', async () => {
    requestExport()
    closeExportDialog()
    useStore.getState().setProject(newProject('Something else'))
    h.native[0].reject(new Error('ffmpeg exited with code 1'))
    await flush()

    const [toast] = useToasts.getState().toasts
    expect(toast.kind).toBe('danger')
    expect(toast.message).toBe('The export of “Holiday” failed: ffmpeg exited with code 1')
    expect(toast.action?.label).toBe('Try again')

    toast.action!.onClick()
    expect(h.native).toHaveLength(2)
    expect(h.native[1].project.name).toBe('Holiday')
    expect(isExportRunning()).toBe(true)
  })

  it('with the dialog open the error stays on it instead of a toast', async () => {
    requestExport()
    h.native[0].reject(new Error('ffmpeg exited with code 1'))
    await flush()
    expect(useExportJob.getState().job?.stage).toEqual({ kind: 'error', message: 'ffmpeg exited with code 1' })
    expect(useToasts.getState().toasts).toHaveLength(0)

    retryExport()
    expect(h.native).toHaveLength(2)
  })
})

describe('the browser path stays up front', () => {
  beforeEach(() => {
    h.electron = false
  })

  it('does not close while it encodes, and retries a GPU B-frame crash in software', async () => {
    h.picker = () => Promise.resolve({ name: 'Holiday.mp4', getFile: () => Promise.resolve({ size: 4000 }) })
    let finish: (v: null) => void = () => {}
    h.browserResults.push(
      () => Promise.reject(new Error('Timestamps must be monotonically increasing')),
      () => new Promise<null>((r) => (finish = r)),
    )

    requestExport()
    await flush()
    await flush()
    expect(useExportJob.getState().job?.stage.kind).toBe('running')
    closeExportDialog()
    expect(useExportJob.getState().dialogOpen).toBe(true)

    expect(h.browser.map((c) => c.settings.hardwareAcceleration)).toEqual(['prefer-hardware', 'prefer-software'])
    finish(null)
    await flush()
    await flush()
    expect(useExportJob.getState().job?.stage).toMatchObject({ kind: 'done', fileName: 'Holiday.mp4', streamed: true })
    expect(useToasts.getState().toasts[0].message).toBe('Export finished: Holiday.mp4 (4 KB)')
  })

  it('closing while the save picker is up means no export', async () => {
    let pick: (v: unknown) => void = () => {}
    h.picker = () => new Promise((r) => (pick = r))
    requestExport()
    expect(useExportJob.getState().job?.stage.kind).toBe('starting')

    closeExportDialog()
    expect(useExportJob.getState().job).toBeNull()
    pick({ name: 'Holiday.mp4', getFile: () => Promise.resolve({ size: 1 }) })
    await flush()
    expect(h.browser).toHaveLength(0)
  })
})

// PLATFORM LOUDNESS. His answer, 2026-09-30, to whether every export should land
// at the loudness YouTube, TikTok and Instagram play videos at: "Yes, on by
// default", with "a switch in the export window turns it off for a video."
describe('platform loudness', () => {
  it('is on by default, and the export carries the platforms\' level', () => {
    requestExport()
    expect(h.native[0].settings.loudnessTargetLufs).toBe(PLATFORM_TARGET_LUFS)
  })

  it('the switch turns it off for THIS video: the export starts again from the same frozen copy', async () => {
    requestExport()
    const first = h.native[0]
    // He edits on while it runs; the restart must still make the file he asked for.
    useStore.getState().dispatch('Rename project', (p) => ({ ...p, name: 'Renamed' }))

    setExportLoudness(false)
    expect(first.signal.aborted).toBe(true)
    await flush()

    expect(h.native).toHaveLength(2)
    const second = h.native[1]
    expect(second.settings.loudnessTargetLufs).toBeNull()
    expect(second.project.name).toBe('Holiday')
    // Same everything else: only the loudness moved.
    expect({ ...second.settings, loudnessTargetLufs: 0 }).toEqual({ ...first.settings, loudnessTargetLufs: 0 })
    // It is still the export on screen, not a cancelled one.
    expect(useExportJob.getState().job?.stage.kind).toBe('running')
    expect(useExportJob.getState().dialogOpen).toBe(true)
  })

  it('remembers which way he left it for the next export', async () => {
    requestExport()
    setExportLoudness(false)
    await flush()
    h.native[1].resolve({ outPath: 'C:\\Videos\\Holiday.mp4', sizeBytes: 1 })
    await flush()
    closeExportDialog()
    expect(useSettings.getState().platformLoudness).toBe(false)

    requestExport()
    expect(h.native[2].settings.loudnessTargetLufs).toBeNull()
  })

  it('flipping it to the value already running restarts nothing', async () => {
    requestExport()
    setExportLoudness(true)
    await flush()
    expect(h.native).toHaveLength(1)
    expect(h.native[0].signal.aborted).toBe(false)
  })
})
