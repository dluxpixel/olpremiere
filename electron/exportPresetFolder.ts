// An export preset's folder, main's half: the folder picker, and a file name in
// that folder that nothing there has.
//
// His words, 2026-10-11: *"when I click Export, it asks me what preset, and when I
// click, for example, Gym Preset, it exports the finished video to a specific
// folder."* The preset (name, folder, setting) lives in the page's preferences
// (src/state/exportPresets.ts); this file is what only main may do.
//
// ⛔ WHY A FOLDER THE PAGE NAMES IS SAFE HERE, WHEN A FILE IT NAMES IS NOT.
// exportChoice.ts refuses any file the page names, because ffmpeg writes with -y and
// would overwrite it. A preset's folder comes back from the page's preferences on
// every start, so main cannot have seen it in a dialog this run. What keeps that
// safe: main makes the file name itself (presetFileName: a name nothing in the
// folder has, so no existing file can be the target), cleans the project name so it
// cannot leave the folder, and takes only an absolute path to a folder that exists.
// The path it makes is then recorded exactly like a dialog answer, so native:start
// takes it back through exportPathFromPage and nothing else.
//
// ⛔ NEVER OVERWRITES. `Name.mp4`, then `Name 2.mp4`, `Name 3.mp4`. The name is
// checked again when ffmpeg starts (refreshPick), because the sound is made in
// between and a file of that name can appear in that time.

import { dialog, type BrowserWindow } from 'electron'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { containerExt } from './exportArgs'
import { choseExportPath } from './exportChoice'
import type { NativeEncoder } from './ipc-types'

/** `Base.ext` when the folder has no such file, else `Base 2.ext`, `Base 3.ext` and on. Pure. */
export function presetFileName(base: string, ext: string, taken: (name: string) => boolean): string {
  const first = `${base}.${ext}`
  if (!taken(first)) return first
  for (let n = 2; n < 100_000; n++) {
    const next = `${base} ${n}.${ext}`
    if (!taken(next)) return next
  }
  return `${base} ${Date.now()}.${ext}`
}

/** A project name as a file name: nothing Windows refuses, no path, no trailing dots or spaces. */
export function sanitizeBase(raw: unknown): string {
  if (typeof raw !== 'string') return 'export'
  // eslint-disable-next-line no-control-regex
  const clean = raw.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '').slice(0, 120)
  return clean === '' || /^\.+$/.test(clean) ? 'export' : clean
}

const isFolder = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** The folder itself, else the nearest one above it that exists: where the picker should open. */
export function nearestExistingFolder(hint: unknown): string | undefined {
  if (typeof hint !== 'string' || !path.isAbsolute(hint)) return undefined
  let dir = path.resolve(hint)
  for (let i = 0; i < 64; i++) {
    if (isFolder(dir)) return dir
    const up = path.dirname(dir)
    if (up === dir) return undefined
    dir = up
  }
  return undefined
}

/** The system folder picker. Null when he dismisses it. `title` names the preset it is for. */
export async function pickPresetFolder(win: BrowserWindow, title: unknown, hint: unknown): Promise<string | null> {
  const res = await dialog.showOpenDialog(win, {
    title: typeof title === 'string' && title !== '' ? title.slice(0, 120) : 'Choose a folder',
    defaultPath: nearestExistingFolder(hint),
    properties: ['openDirectory', 'createDirectory'],
  })
  if (res.canceled || !res.filePaths[0]) return null
  return res.filePaths[0]
}

/** The names main itself made for presets this run, with the folder and name they came from. */
const picks = new Map<string, { folder: string; base: string; ext: string }>()

export type PresetOutput = { ok: true; outPath: string } | { ok: false; reason: 'no-folder' }

/**
 * A new file name in `folder` for `base`. `no-folder` when the folder is not an
 * absolute path to a folder that exists (it was deleted, renamed, or a drive is
 * gone), and the page then asks him for another.
 */
export function presetOutput(folder: unknown, base: unknown, encoder: unknown): PresetOutput {
  if (typeof folder !== 'string' || !path.isAbsolute(folder) || !isFolder(folder)) return { ok: false, reason: 'no-folder' }
  const dir = path.resolve(folder)
  const name = sanitizeBase(base)
  const ext = containerExt(typeof encoder === 'string' ? (encoder as NativeEncoder) : 'x264')
  const outPath = path.join(dir, presetFileName(name, ext, (n) => existsSync(path.join(dir, n))))
  picks.set(outPath, { folder: dir, base: name, ext })
  choseExportPath(outPath)
  return { ok: true, outPath }
}

/**
 * Called when ffmpeg is about to start on `outPath`. For a file main named for a
 * preset, a name that has been taken since moves to the next free one. Any other
 * path comes back as it is.
 */
export function refreshPick(outPath: string): string {
  const made = picks.get(path.resolve(outPath)) ?? picks.get(outPath)
  if (!made || !existsSync(outPath)) return outPath
  const next = path.join(made.folder, presetFileName(made.base, made.ext, (n) => existsSync(path.join(made.folder, n))))
  picks.set(next, made)
  choseExportPath(next)
  return next
}
