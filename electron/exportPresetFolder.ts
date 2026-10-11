// An export preset's folder, main's half: the folder picker, and a file name in
// that folder that nothing there has.
//
// His words, 2026-10-11: *"when I click Export, it asks me what preset, and when I
// click, for example, Gym Preset, it exports the finished video to a specific
// folder."* The preset (name, folder) lives in the page's preferences
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
// ⛔ NEVER OVERWRITES. `Name.mp4`, then `Name 2.mp4`, `Name 3.mp4`. When ffmpeg
// starts, the name is taken for real (claimPick): an empty file made with 'wx',
// which fails if anything has the name, so nothing can slip in between a check and
// ffmpeg's -y. The sound is made in between, so a file of that name can appear.
//
// ⛔ NEVER A NETWORK PATH (\\host\share, \\?\). The folder rides in the page's
// preferences, so a \\ path there is refused and the page asks with the picker again.

import { dialog, type BrowserWindow } from 'electron'
import { closeSync, existsSync, openSync, statSync } from 'node:fs'
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

/**
 * A project name as a file name: nothing Windows refuses, no path, no trailing dots or
 * spaces, no device name. `max` keeps the whole path short enough for Windows.
 */
export function sanitizeBase(raw: unknown, max = 120): string {
  if (typeof raw !== 'string') return 'export'
  let clean = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .replace(/[. ]+$/, '')
  if (clean === '' || /^\.+$/.test(clean)) return 'export'
  // ⛔ CON, NUL, COM1 and the rest are devices to Windows, with or without an
  // extension, and ffmpeg makes files under those names that nothing can delete.
  if (/^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])$/i.test(clean.split('.')[0].trim())) clean = 'export ' + clean
  return clean
}

/** \\host\share, \\?\C:\ and the like: never where a preset writes or the picker opens. */
const isNetworkPath = (p: string): boolean => /^[\\/]{2}/.test(p) || path.resolve(p).startsWith('\\\\')

const isFolder = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** The folder itself, else the nearest one above it that exists: where the picker should open. */
export function nearestExistingFolder(hint: unknown): string | undefined {
  if (typeof hint !== 'string' || !path.isAbsolute(hint) || isNetworkPath(hint)) return undefined
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
  if (typeof folder !== 'string' || !path.isAbsolute(folder) || isNetworkPath(folder) || !isFolder(folder)) {
    return { ok: false, reason: 'no-folder' }
  }
  const dir = path.resolve(folder)
  const name = sanitizeBase(base, Math.max(24, 240 - dir.length))
  const ext = containerExt(typeof encoder === 'string' ? (encoder as NativeEncoder) : 'x264')
  const outPath = path.join(dir, presetFileName(name, ext, (n) => existsSync(path.join(dir, n))))
  picks.set(outPath, { folder: dir, base: name, ext })
  choseExportPath(outPath)
  return { ok: true, outPath }
}

/** Makes `p` as an empty file, only if nothing has that name. False when something does. */
function takeName(p: string): boolean {
  try {
    closeSync(openSync(p, 'wx'))
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw err
  }
}

/**
 * Called when ffmpeg is about to start on `outPath`. For a file main named for a
 * preset, the name is taken for real: an empty placeholder, made only if nothing has
 * the name, else the next free `Name N.ext`. ffmpeg then writes over that placeholder
 * and nothing else. `placeholder` says one was made, so a failed start can remove it.
 * Any other path comes back as it is. Throws when the folder refuses the file.
 */
export function claimPick(outPath: string): { outPath: string; placeholder: boolean } {
  const made = picks.get(path.resolve(outPath)) ?? picks.get(outPath)
  if (!made) return { outPath, placeholder: false }
  let next = outPath
  for (let n = 2; !takeName(next); n++) {
    next = path.join(made.folder, n < 100_000 ? `${made.base} ${n}.${made.ext}` : `${made.base} ${Date.now()} ${n}.${made.ext}`)
  }
  picks.set(next, made)
  choseExportPath(next)
  return { outPath: next, placeholder: true }
}
