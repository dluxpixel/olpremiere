/**
 * @vitest-environment jsdom
 *
 * EXPORT ASKS WHICH PRESET, AND A PRESET REMEMBERS ITS OWN FOLDER.
 *
 * His words, 2026-10-11: *"when I click Export, it asks me what preset, and when I
 * click, for example, Gym Preset, it exports the finished video to a specific
 * folder where it pops up that option for me."*
 *
 * The desktop shell is faked (folder picker, the file name main makes in a folder);
 * the encode is parked, as in ExportDialog.test.tsx. What is proven here is the
 * window and the job: the list, making and editing a preset, the folder asked once
 * and then remembered, a gone folder asked for again, and the plain one off export.
 */
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PLATFORM_TARGET_LUFS } from '../engine/loudness'
import { activeSequence, newProject, type Clip, type Project } from '../engine/types'
import type { ExportSettings } from '../engine/export'
import { askExport, cancelExport, useExportJob } from '../state/exportJob'
import { createPreset, EXPORT_PRESETS_KEY, reloadExportPresets, useExportPresets } from '../state/exportPresets'
import { setPlatformLoudness, useSettings } from '../state/settings'
import { useStore } from '../state/store'
import { ExportDialog } from './ExportDialog'

interface NativeCall {
  settings: ExportSettings
  outPath: string | undefined
  resolve: (r: { outPath: string; sizeBytes: number }) => void
}

const h = vi.hoisted(() => ({
  native: [] as unknown[],
  /** What the folder picker answers, in order; null is a dismissed picker. */
  answers: [] as (string | null)[],
  asked: [] as { title: string; hint: string | null }[],
  /** Folders that no longer exist, and the files main has made in the others. */
  gone: new Set<string>(),
  used: new Set<string>(),
  made: [] as { folder: string; base: string }[],
}))
const calls = () => h.native as NativeCall[]

vi.mock('../platform', () => ({ isElectron: true, olApi: undefined }))

vi.mock('../engine/export/nativeExport', () => ({
  exportNative: (
    _project: unknown,
    settings: ExportSettings,
    opts: { outPath?: string; onOutPath?: (p: string) => void },
    _onProgress: unknown,
    signal: AbortSignal,
  ) =>
    new Promise((resolve, reject) => {
      if (opts.outPath) opts.onOutPath?.(opts.outPath)
      h.native.push({ settings, outPath: opts.outPath, resolve })
      signal.addEventListener('abort', () => reject(new DOMException('Export cancelled', 'AbortError')))
    }),
}))

vi.mock('../engine/export', () => ({
  canStreamToDisk: () => false,
  pickExportDestination: () => Promise.resolve(null),
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

let revealed: string[] = []

/** The faked desktop shell: main's folder picker, and the name main makes (Name.mp4, Name 2.mp4) in a folder. */
function fakeShell(withFolders = true) {
  return {
    isElectron: true,
    exportReveal: (p: string) => {
      revealed.push(p)
      return Promise.resolve()
    },
    ...(withFolders
      ? {
          exportPickFolder: (title: string, hint: string | null) => {
            h.asked.push({ title, hint })
            return Promise.resolve(h.answers.shift() ?? null)
          },
          exportPresetOutput: (folder: string, base: string) => {
            if (h.gone.has(folder)) return Promise.resolve({ ok: false, reason: 'no-folder' })
            h.made.push({ folder, base })
            let name = `${base}.mp4`
            for (let n = 2; h.used.has(`${folder}/${name}`); n++) name = `${base} ${n}.mp4`
            h.used.add(`${folder}/${name}`)
            return Promise.resolve({ ok: true, outPath: `${folder}/${name}` })
          },
        }
      : {}),
  }
}

beforeEach(() => {
  h.native.length = 0
  h.answers.length = 0
  h.asked.length = 0
  h.gone.clear()
  h.used.clear()
  h.made.length = 0
  revealed = []
  localStorage.clear()
  reloadExportPresets()
  setPlatformLoudness(true)
  ;(window as unknown as { api: unknown }).api = fakeShell()
  useStore.getState().setProject(projectWithClip('Holiday'))
})

afterEach(async () => {
  cleanup()
  cancelExport()
  await flush()
  useExportJob.setState({ job: null, dialogOpen: false, alreadyRunning: false, choosing: false })
  delete (window as unknown as { api?: unknown }).api
})

const openChooser = () => {
  act(() => askExport())
  render(<ExportDialog />)
}
const storedPresets = () => JSON.parse(localStorage.getItem(EXPORT_PRESETS_KEY) ?? '[]') as { name: string; folder: string | null }[]

describe('the Export button asks which preset', () => {
  it('opens the list with only "New preset" and "Just this once", and starts nothing', () => {
    openChooser()
    expect(screen.getByTestId('export-chooser')).toBeTruthy()
    expect(screen.queryAllByTestId('export-preset-row')).toHaveLength(0)
    expect(screen.getByTestId('export-new-preset').textContent).toContain('New preset')
    expect(screen.getByTestId('export-once').textContent).toContain('Just this once')
    expect(screen.getByTestId('export-project').textContent).toBe('Holiday')
    expect(useExportJob.getState().job).toBeNull()
    expect(calls()).toHaveLength(0)
  })

  it('without the folder calls (the browser, an old shell) it is the immediate export it always was', async () => {
    ;(window as unknown as { api: unknown }).api = fakeShell(false)
    act(() => askExport())
    render(<ExportDialog />)
    await act(flush)
    expect(useExportJob.getState().choosing).toBe(false)
    expect(calls()).toHaveLength(1)
  })

  it('Close only closes the question', async () => {
    const user = userEvent.setup()
    openChooser()
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByTestId('export-dialog')).toBeNull()
    expect(useExportJob.getState().job).toBeNull()
    expect(calls()).toHaveLength(0)
  })
})

describe('making a preset', () => {
  it('"Save as preset" lists it, with no folder yet, and keeps it in the preferences', async () => {
    const user = userEvent.setup()
    openChooser()
    await user.click(screen.getByTestId('export-new-preset'))
    const save = screen.getByTestId('export-preset-save') as HTMLButtonElement
    expect(save.disabled).toBe(true) // a blank name makes nothing
    await user.type(screen.getByTestId('export-preset-name'), 'Gym')
    // A preset is a name and a folder: no setting of its own to choose.
    expect(screen.queryByTestId('export-preset-loudness')).toBeNull()
    await user.click(save)

    const row = screen.getByTestId('export-preset-row')
    expect(row.textContent).toContain('Gym')
    expect(row.textContent).toContain('Folder not chosen yet')
    expect(calls()).toHaveLength(0)
    expect(storedPresets()).toMatchObject([{ name: 'Gym', folder: null }])
    expect(storedPresets()[0]).not.toHaveProperty('platformLoudness')
  })

  it('"Save and export" makes it and starts with it, asking for its folder', async () => {
    const user = userEvent.setup()
    h.answers.push('D:/Gym videos')
    openChooser()
    await user.click(screen.getByTestId('export-new-preset'))
    await user.type(screen.getByTestId('export-preset-name'), 'Gym')
    await user.click(screen.getByTestId('export-preset-save-export'))
    await waitFor(() => expect(calls()).toHaveLength(1))
    expect(h.asked).toEqual([{ title: 'Folder for Gym', hint: null }])
    expect(calls()[0].outPath).toBe('D:/Gym videos/Holiday.mp4')
  })
})

describe('exporting with a preset', () => {
  it('⛔ the first use asks for the folder once and remembers it; the next export goes straight there, named "Holiday 2"', async () => {
    const user = userEvent.setup()
    h.answers.push('D:/Gym videos')
    createPreset('Gym')
    openChooser()
    await user.click(screen.getByTestId('export-preset-start'))
    await waitFor(() => expect(calls()).toHaveLength(1))

    // The window's own setting (on) is the one this video was made with.
    expect(calls()[0].settings.loudnessTargetLufs).toBe(PLATFORM_TARGET_LUFS)
    expect(calls()[0].outPath).toBe('D:/Gym videos/Holiday.mp4')
    expect(h.asked).toHaveLength(1)
    expect(useExportPresets.getState().presets[0].folder).toBe('D:/Gym videos')
    expect(storedPresets()[0].folder).toBe('D:/Gym videos')

    // Done: the file is named on the done screen and "Show in folder" opens it.
    act(() => calls()[0].resolve({ outPath: 'D:/Gym videos/Holiday.mp4', sizeBytes: 5e6 }))
    await user.click(await screen.findByTestId('export-reveal'))
    expect(revealed).toEqual(['D:/Gym videos/Holiday.mp4'])
    await user.click(screen.getByRole('button', { name: 'Done' }))

    // Again: no folder prompt, a name nothing there has.
    act(() => askExport())
    await user.click(await screen.findByTestId('export-preset-start'))
    await waitFor(() => expect(calls()).toHaveLength(2))
    expect(h.asked).toHaveLength(1)
    expect(calls()[1].outPath).toBe('D:/Gym videos/Holiday 2.mp4')
    expect(h.used.has('D:/Gym videos/Holiday.mp4')).toBe(true)
  })

  it('⛔ a preset exports with the window\'s own setting, and never changes it', async () => {
    const user = userEvent.setup()
    setPlatformLoudness(false)
    createPreset('Loud', 'D:/Loud')
    openChooser()
    await user.click(screen.getByTestId('export-preset-start'))
    await waitFor(() => expect(calls()).toHaveLength(1))
    expect(calls()[0].settings.loudnessTargetLufs).toBeNull()
    expect(useSettings.getState().platformLoudness).toBe(false)
    expect(h.asked).toHaveLength(0)
  })

  it('⛔ a folder that is gone is forgotten and the picker opens where it was', async () => {
    const user = userEvent.setup()
    h.gone.add('D:/Old')
    h.answers.push('D:/New')
    createPreset('Gym', 'D:/Old')
    openChooser()
    await user.click(screen.getByTestId('export-preset-start'))
    await waitFor(() => expect(calls()).toHaveLength(1))
    expect(h.asked).toEqual([{ title: 'Folder for Gym', hint: 'D:/Old' }])
    expect(calls()[0].outPath).toBe('D:/New/Holiday.mp4')
    expect(useExportPresets.getState().presets[0].folder).toBe('D:/New')
  })

  it('a second folder that does not work says so plainly, keeps the saved folder, and Try again asks', async () => {
    const user = userEvent.setup()
    h.gone.add('D:/Old').add('D:/Also gone')
    h.answers.push('D:/Also gone')
    createPreset('Gym', 'D:/Old')
    openChooser()
    await user.click(screen.getByTestId('export-preset-start'))
    expect((await screen.findByTestId('export-error')).textContent).toContain('Could not write the file there')
    // Only a folder that works replaces it: a failure never wipes it.
    expect(useExportPresets.getState().presets[0].folder).toBe('D:/Old')
    expect(calls()).toHaveLength(0)

    h.gone.delete('D:/Also gone')
    h.answers.push('D:/Fine')
    await user.click(screen.getByTestId('export-retry'))
    await waitFor(() => expect(calls()).toHaveLength(1))
    expect(calls()[0].outPath).toBe('D:/Fine/Holiday.mp4')
    expect(useExportPresets.getState().presets[0].folder).toBe('D:/Fine')
  })

  it('dismissing the folder picker is a quiet cancel: nothing starts, no error, no folder kept', async () => {
    const user = userEvent.setup()
    h.answers.push(null)
    createPreset('Gym')
    openChooser()
    await user.click(screen.getByTestId('export-preset-start'))
    await waitFor(() => expect(screen.queryByTestId('export-dialog')).toBeNull())
    expect(useExportJob.getState().job).toBeNull()
    expect(calls()).toHaveLength(0)
    expect(useExportPresets.getState().presets[0].folder).toBeNull()
  })

  it('⛔ dismissing the picker for a gone folder keeps the old path', async () => {
    const user = userEvent.setup()
    h.gone.add('D:/Old')
    h.answers.push(null)
    createPreset('Gym', 'D:/Old')
    openChooser()
    await user.click(screen.getByTestId('export-preset-start'))
    await waitFor(() => expect(screen.queryByTestId('export-dialog')).toBeNull())
    expect(h.asked).toEqual([{ title: 'Folder for Gym', hint: 'D:/Old' }])
    expect(calls()).toHaveLength(0)
    expect(useExportPresets.getState().presets[0].folder).toBe('D:/Old')
  })

  it('"Just this once" is the plain export: the save dialog names the file, the setting is the window\'s own', async () => {
    const user = userEvent.setup()
    createPreset('Gym', 'D:/Gym videos')
    openChooser()
    await user.click(screen.getByTestId('export-once'))
    await waitFor(() => expect(calls()).toHaveLength(1))
    expect(calls()[0].outPath).toBeUndefined()
    expect(calls()[0].settings.loudnessTargetLufs).toBe(PLATFORM_TARGET_LUFS)
    expect(h.asked).toHaveLength(0)
    expect(h.made).toHaveLength(0)
  })
})

describe('changing a preset', () => {
  it('rename, the folder and delete each apply at once', async () => {
    const user = userEvent.setup()
    createPreset('Gym', 'D:/A')
    createPreset('Edits', 'D:/E')
    openChooser()
    const rows = screen.getAllByTestId('export-preset-row')
    expect(rows).toHaveLength(2)
    await user.click(within(rows[0]).getByTestId('export-preset-edit'))

    const name = screen.getByTestId('export-preset-name')
    await user.clear(name)
    await user.type(name, 'Lift')
    h.answers.push('D:/B')
    await user.click(screen.getByTestId('export-preset-change-folder'))
    await waitFor(() => expect(screen.getByTestId('export-preset-folder').textContent).toBe('D:/B'))
    expect(h.asked[0]).toEqual({ title: 'Folder for Lift', hint: 'D:/A' })
    await user.click(screen.getByTestId('export-preset-done'))

    expect(storedPresets()[0]).toMatchObject({ name: 'Lift', folder: 'D:/B' })
    expect(screen.getAllByTestId('export-preset-row')[0].textContent).toContain('Lift')

    await user.click(within(screen.getAllByTestId('export-preset-row')[0]).getByTestId('export-preset-edit'))
    await user.click(screen.getByTestId('export-preset-delete'))
    expect(screen.getAllByTestId('export-preset-row')).toHaveLength(1)
    expect(storedPresets().map((p) => p.name)).toEqual(['Edits'])
  })

  it('a blank name is refused and the old one stays', async () => {
    const user = userEvent.setup()
    createPreset('Gym', 'D:/A')
    openChooser()
    await user.click(screen.getByTestId('export-preset-edit'))
    await user.clear(screen.getByTestId('export-preset-name'))
    await user.click(screen.getByTestId('export-preset-done'))
    expect(screen.getByTestId('export-preset-row').textContent).toContain('Gym')
  })
})
