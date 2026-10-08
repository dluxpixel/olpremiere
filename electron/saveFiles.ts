// Where the files he saves go, and what they are called.
//
// ⛔ NEVER "DO YOU WANT TO REPLACE THAT?", 2026-09-28. His words: *"when I export
// it, the name is 'untitled project.mp4'. Every time I export something, it asks
// me, 'Do you want to replace that?' Of course not. Make it like _1 _2 for every
// single export ... like photoshop"*, and *"make sure it also counts when you're
// saving projects"*.
//
// The save dialog opens in the folder he last saved that kind of file to, with a
// name nothing there already has: the project's own name, then `_1`, `_2` and on.
// He can still type any name he likes; only the suggestion is numbered.

import { app, dialog, type BrowserWindow } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { open, rename, statfs, unlink, type FileHandle } from 'node:fs/promises'
import path from 'node:path'

/** `base.ext` when it is free, else `base_1.ext`, `base_2.ext` and on. Pure. */
export function numberedFileName(base: string, ext: string, taken: (name: string) => boolean): string {
  const clean = base.trim() || 'Untitled'
  const first = `${clean}.${ext}`
  if (!taken(first)) return first
  for (let n = 1; n < 100_000; n++) {
    const next = `${clean}_${n}.${ext}`
    if (!taken(next)) return next
  }
  return `${clean}_${Date.now()}.${ext}`
}

export type SaveKind = 'export' | 'project'

const foldersFile = (): string => path.join(app.getPath('userData'), 'save-folders.json')

function readFolders(): Partial<Record<SaveKind, string>> {
  try {
    return JSON.parse(readFileSync(foldersFile(), 'utf8')) as Partial<Record<SaveKind, string>>
  } catch {
    return {}
  }
}

/** The folder he last saved this kind of file to, or a sensible first one. */
export function lastFolder(kind: SaveKind): string {
  const known = readFolders()[kind]
  if (known && existsSync(known)) return known
  return app.getPath(kind === 'export' ? 'videos' : 'documents')
}

export function rememberFolder(kind: SaveKind, filePath: string): void {
  try {
    writeFileSync(foldersFile(), JSON.stringify({ ...readFolders(), [kind]: path.dirname(filePath) }), 'utf8')
  } catch {
    // Only the next suggestion is worse for it.
  }
}

/** The suggested full path: his last folder, a name nobody there has yet. */
export function suggestedPath(kind: SaveKind, base: string, ext: string): string {
  const dir = lastFolder(kind)
  return path.join(dir, numberedFileName(base, ext, (name) => existsSync(path.join(dir, name))))
}

/**
 * Ask where to save, starting from a numbered name in his last folder. Returns
 * the chosen path, or null when he cancelled. The path is then the ONLY one the
 * renderer may write to (see openForWrite).
 */
export async function pickSavePath(
  win: BrowserWindow,
  kind: SaveKind,
  base: string,
  ext: string,
  filterName: string,
): Promise<string | null> {
  const res = await dialog.showSaveDialog(win, {
    title: kind === 'export' ? 'Export video' : 'Save project file',
    defaultPath: suggestedPath(kind, base, ext),
    filters: [{ name: filterName, extensions: [ext] }],
  })
  if (res.canceled || !res.filePath) return null
  rememberFolder(kind, res.filePath)
  picked.add(path.resolve(res.filePath))
  return res.filePath
}

// ---------------------------------------------------------------------------
// Streaming a big file from the renderer, one chunk at a time. A project file
// carries its footage and can be gigabytes, so it cannot cross in one message.
// Written beside the target and renamed over it at the end, so a save cut off
// half way never leaves half a file under his name.

const picked = new Set<string>()
const writes = new Map<number, { fh: FileHandle; tmp: string; target: string }>()
let nextWrite = 1

/**
 * True when the drive holding `dir` has room for `bytes` more, or when it cannot
 * be asked (then the write itself is the test). Pure enough to test: the
 * drive's answer is passed in.
 */
export async function hasRoomFor(
  dir: string,
  bytes: number,
  ask: (dir: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }> = statfs,
): Promise<boolean> {
  try {
    const s = await ask(dir)
    return Number(s.bavail) * Number(s.bsize) >= bytes
  } catch {
    return true
  }
}

/**
 * `sizeBytes`, when known, is checked against the free space FIRST.
 *
 * ⛔ HIS DRIVE IS 97% FULL, and a project copy carries its footage (mc night is
 * about 2.8 GB). Running out half way used to leave nothing but "Could not save
 * the project file". The error says ENOSPC, which the page turns into the
 * sentence with the size in it.
 */
export async function openForWrite(target: string, sizeBytes = 0): Promise<number> {
  const resolved = path.resolve(target)
  // Only a path he chose in the dialog above. The renderer must not be able to
  // turn this into a write-anywhere primitive.
  if (!picked.has(resolved)) throw new Error('That file was not chosen in a save dialog')
  picked.delete(resolved)
  if (sizeBytes > 0 && !(await hasRoomFor(path.dirname(resolved), sizeBytes))) {
    throw new Error(`ENOSPC: not enough space for ${sizeBytes} bytes`)
  }
  const tmp = `${resolved}.olpart`
  const fh = await open(tmp, 'w')
  const id = nextWrite++
  writes.set(id, { fh, tmp, target: resolved })
  return id
}

export async function writeChunk(id: number, chunk: ArrayBuffer): Promise<void> {
  const w = writes.get(id)
  if (!w) throw new Error('No such file open')
  await w.fh.write(Buffer.from(chunk))
}

export async function closeWrite(id: number, ok: boolean): Promise<void> {
  const w = writes.get(id)
  if (!w) return
  writes.delete(id)
  await w.fh.close()
  if (ok) await rename(w.tmp, w.target)
  else await unlink(w.tmp).catch(() => undefined)
}

/**
 * Throw away every write still open, when the page that was feeding them has gone
 * (a reload, a crash). Nothing can ever finish them, and each one is a full size
 * `<name>.olpart` beside his file: a project copy carries all its footage (mc
 * night is about 2.8 GB) on a drive that is 97% full. Never renamed into place,
 * so his own file is never touched.
 */
export async function dropWrites(): Promise<void> {
  for (const id of [...writes.keys()]) await closeWrite(id, false).catch(() => undefined)
}
