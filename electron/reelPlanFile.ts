// A reel plan, in main: pick the .json (or take a path), read it, check it, and make
// sure every clip it names is really on disk. ANY problem refuses the whole plan and
// nothing is half imported. A missing clip is named by its path.
//
// The page cannot read a path itself, so a plan that passes also becomes the ONLY set
// of files the page may ask main to stream back (readReelClip). Same stance as
// backup:read and project:read: main serves what it checked, it is never a general
// file reader. That is why the list is replaced on every import, holds only the clips
// of the last plan that passed, and only video extensions.
//
// This writes nothing. The project is built by the page and saved by the app's own
// save code.

import { open, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { dialog, type BrowserWindow } from 'electron'
import type { ReelPlanClipFile, ReelPlanImportResult } from './ipc-types'
import { readChunk } from './readChunk'
import { parseReelPlan } from './reelPlan'

/** A plan is a few KB. Anything near this is not one, and is never read whole. */
const MAX_PLAN_BYTES = 2 * 1024 * 1024
/** The most one read may ask for. The page asks for 8 MB. */
const MAX_READ_BYTES = 16 * 1024 * 1024

/** The video containers a clip may be, with the type the page probes it by. */
const CLIP_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
  '.3gp': 'video/3gpp',
}

interface Approved {
  path: string
  size: number
}
/** Clip id to file, for the last plan that passed. */
let approved = new Map<string, Approved>()

async function planPathFromDialog(win: BrowserWindow | null): Promise<string | null> {
  const opts = {
    title: 'Import reel plan',
    properties: ['openFile' as const],
    filters: [{ name: 'Reel plan', extensions: ['json'] }],
  }
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  if (res.canceled || !res.filePaths[0]) return null
  return res.filePaths[0]
}

/**
 * Pick, read and check a plan. `given` is a path to a .json (used when something other
 * than the dialog already knows which plan); anything else opens the dialog.
 */
export async function importReelPlan(win: BrowserWindow | null, given?: unknown): Promise<ReelPlanImportResult> {
  let planPath: string
  if (typeof given === 'string' && given.length > 0) {
    planPath = given
  } else {
    const picked = await planPathFromDialog(win)
    if (picked === null) return { status: 'cancelled' }
    planPath = picked
  }

  const refuse = (problems: string[]): ReelPlanImportResult => {
    approved = new Map()
    return { status: 'refused', problems }
  }

  if (path.extname(planPath).toLowerCase() !== '.json' || !path.isAbsolute(planPath)) {
    return refuse(['A reel plan is a .json file, given by its full path.'])
  }
  let text: string
  try {
    const info = await stat(planPath)
    if (!info.isFile()) return refuse([`The reel plan is not a file: ${planPath}`])
    if (info.size > MAX_PLAN_BYTES) return refuse(['That file is too big to be a reel plan.'])
    text = await readFile(planPath, 'utf8')
  } catch {
    return refuse([`The reel plan could not be read: ${planPath}`])
  }

  const checked = parseReelPlan(text)
  if (!checked.ok) return refuse(checked.problems)
  const plan = checked.plan

  // Every clip must be a video file that is really there. All of them are checked, so
  // one pass names every missing file.
  const problems: string[] = []
  const found = new Map<string, Approved>()
  const files: ReelPlanClipFile[] = []
  for (let i = 0; i < plan.clips.length; i++) {
    const clip = plan.clips[i]
    const at = `clips[${i}]`
    if (!path.isAbsolute(clip.path)) {
      problems.push(`${at}: the path must be a full path, not ${clip.path}`)
      continue
    }
    const mime = CLIP_TYPES[path.extname(clip.path).toLowerCase()]
    if (mime === undefined) {
      problems.push(`${at}: not a video file the editor takes: ${clip.path}`)
      continue
    }
    try {
      const info = await stat(clip.path)
      if (!info.isFile()) {
        problems.push(`${at}: not a file: ${clip.path}`)
        continue
      }
      found.set(clip.id, { path: clip.path, size: info.size })
      files.push({ id: clip.id, name: path.basename(clip.path), size: info.size, mime })
    } catch {
      problems.push(`${at}: the clip is missing: ${clip.path}`)
    }
  }
  if (problems.length > 0) return refuse(problems)

  approved = found
  return { status: 'plan', plan, fileName: path.basename(planPath), files }
}

/**
 * One slice of a clip of the plan that passed. Throws for anything else: an id the last
 * plan did not name, or a range that is not inside the file.
 */
export async function readReelClip(clipId: unknown, offset: unknown, length: unknown): Promise<ArrayBuffer> {
  const clip = typeof clipId === 'string' ? approved.get(clipId) : undefined
  if (!clip) throw new Error('Refused: not a clip of the reel plan')
  if (
    typeof offset !== 'number' ||
    typeof length !== 'number' ||
    !Number.isInteger(offset) ||
    !Number.isInteger(length) ||
    offset < 0 ||
    length <= 0 ||
    length > MAX_READ_BYTES ||
    offset + length > clip.size
  ) {
    throw new Error('Refused: that range is not inside the clip')
  }
  const handle = await open(clip.path, 'r')
  try {
    return await readChunk(handle, offset, length)
  } finally {
    await handle.close().catch(() => undefined)
  }
}
