/**
 * @vitest-environment jsdom
 *
 * THE EXPORT DIALOG CLOSES WHILE THE FILE IS STILL BEING MADE.
 *
 * His words, 2026-09-28: *"Make it so that while the video is exporting, I can
 * work on other videos too, because the export time is sometimes very long."*
 *
 * Until then the dialog covered the whole editor and would not close while it
 * ran. Rendered here with the top bar chip beside it, because the two together
 * are the whole way back to a running export once the dialog is gone.
 */
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { activeSequence, newProject, type Clip, type Project } from '../engine/types'
import type { ExportProgress } from '../engine/export/messages'
import { cancelExport, requestExport, useExportJob } from '../state/exportJob'
import { useStore } from '../state/store'
import { ExportChip } from './ExportChip'
import { ExportDialog } from './ExportDialog'

interface NativeCall {
  onProgress: (p: ExportProgress) => void
  signal: AbortSignal
}

const h = vi.hoisted(() => ({ electron: true, native: [] as NativeCall[] }))

vi.mock('../platform', () => ({
  get isElectron() {
    return h.electron
  },
  olApi: undefined,
}))

vi.mock('../engine/export/nativeExport', () => ({
  exportNative: (
    _project: unknown,
    _settings: unknown,
    _opts: unknown,
    onProgress: (p: ExportProgress) => void,
    signal: AbortSignal,
  ) =>
    new Promise((_resolve, reject) => {
      h.native.push({ onProgress, signal })
      signal.addEventListener('abort', () => reject(new DOMException('Export cancelled', 'AbortError')))
    }),
}))

vi.mock('../engine/export', () => ({
  canStreamToDisk: () => false,
  pickExportDestination: () => Promise.resolve(null),
  // The browser path's encode, parked so it stays "running".
  exportSequence: () => new Promise(() => {}),
}))

const flush = () => new Promise((r) => setTimeout(r, 0))

function projectWithClip(name: string): Project {
  const p = newProject(name)
  const seq = activeSequence(p)
  p.assets = { a1: { id: 'a1', name: 'clip.mp4', kind: 'video', blobKey: 'asset/a1', durationS: 5 } as Project['assets'][string] }
  seq.durationS = 5
  seq.tracks[0].clips = [{ id: 'c1', assetId: 'a1', startS: 0, inS: 0, outS: 5, speed: 1, enabled: true } as unknown as Clip]
  return p
}

function renderBar() {
  return render(
    <>
      <ExportChip />
      <ExportDialog />
    </>,
  )
}

beforeEach(() => {
  h.electron = true
  h.native.length = 0
  useStore.getState().setProject(projectWithClip('Holiday'))
})

afterEach(async () => {
  cleanup()
  cancelExport()
  await flush()
  useExportJob.setState({ job: null, dialogOpen: false, alreadyRunning: false })
})

describe('on the desktop', () => {
  it('Keep working closes it, the export goes on, and the chip brings it back', async () => {
    const user = userEvent.setup()
    act(() => requestExport())
    renderBar()
    expect(screen.getByTestId('export-dialog')).toBeTruthy()

    await user.click(screen.getByTestId('export-keep-working'))
    expect(screen.queryByTestId('export-dialog')).toBeNull()
    expect(h.native[0].signal.aborted).toBe(false)

    // The chip carries the percent and which project it is.
    act(() => h.native[0].onProgress({ phase: 'video', framesDone: 75, framesTotal: 150 }))
    const chip = screen.getByTestId('export-chip')
    expect(chip.textContent).toContain('50%')
    expect(chip.textContent).toContain('Holiday')

    // He opens another project; the chip still names the one being made.
    act(() => useStore.getState().setProject(newProject('Other')))
    expect(screen.getByTestId('export-chip').textContent).toContain('Holiday')

    await user.click(screen.getByTestId('export-chip-open'))
    expect(screen.getByTestId('export-dialog')).toBeTruthy()
    expect(screen.getByTestId('export-project').textContent).toBe('Holiday')
  })

  it('Escape, the backdrop and the close button all close it while it runs', async () => {
    const user = userEvent.setup()
    act(() => requestExport())
    renderBar()

    await user.keyboard('{Escape}')
    expect(screen.queryByTestId('export-dialog')).toBeNull()

    await user.click(screen.getByTestId('export-chip-open'))
    const backdrop = screen.getByTestId('export-dialog').parentElement!
    await user.pointer({ keys: '[MouseLeft]', target: backdrop })
    expect(screen.queryByTestId('export-dialog')).toBeNull()

    await user.click(screen.getByTestId('export-chip-open'))
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByTestId('export-dialog')).toBeNull()

    expect(h.native[0].signal.aborted).toBe(false)
    expect(h.native).toHaveLength(1)
  })

  it('Export while one runs shows the running one and says why', async () => {
    const user = userEvent.setup()
    act(() => requestExport())
    renderBar()
    await user.click(screen.getByTestId('export-keep-working'))
    expect(screen.queryByTestId('export-already-running')).toBeNull()

    act(() => requestExport())
    expect(screen.getByTestId('export-dialog')).toBeTruthy()
    expect(screen.getByTestId('export-already-running')).toBeTruthy()
    expect(h.native).toHaveLength(1)
  })

  it('the chip stops the export only on a second click', async () => {
    const user = userEvent.setup()
    act(() => requestExport())
    renderBar()
    await user.click(screen.getByTestId('export-keep-working'))

    await user.click(screen.getByTestId('export-chip-cancel'))
    expect(h.native[0].signal.aborted).toBe(false)
    expect(screen.getByTestId('export-chip-cancel').getAttribute('data-armed')).toBe('true')

    await user.click(screen.getByTestId('export-chip-cancel'))
    expect(h.native[0].signal.aborted).toBe(true)
    await act(flush)
    expect(screen.queryByTestId('export-chip')).toBeNull()
  })
})

describe('in the browser', () => {
  it('stays up while it encodes, as before, and shows no chip', async () => {
    h.electron = false
    const user = userEvent.setup()
    act(() => requestExport())
    renderBar()
    await act(flush)
    expect(useExportJob.getState().job?.stage.kind).toBe('running')

    expect(screen.queryByTestId('export-keep-working')).toBeNull()
    expect((screen.getByRole('button', { name: 'Close' }) as HTMLButtonElement).disabled).toBe(true)
    await user.keyboard('{Escape}')
    expect(screen.getByTestId('export-dialog')).toBeTruthy()
    expect(screen.queryByTestId('export-chip')).toBeNull()
  })
})
