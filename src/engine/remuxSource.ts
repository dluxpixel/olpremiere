// Renderer half of "his OBS captures import like anything else".
//
// A .mkv cannot be opened by Chromium at all, so `probeFile` fails on it before
// an asset exists. This hands the file to the desktop shell, which changes the
// container with ffmpeg and hands back an MP4, and the import carries on with
// that. Everything downstream, probe, preview, proxy, export, is unchanged code.
//
// The decision about WHICH files and WHAT ffmpeg does lives in
// `electron/remuxArgs.ts` and is unit tested there.

import { needsRemux } from '../../electron/remuxArgs'

/** 8 MB. Big enough that a multi-gigabyte capture is not millions of round trips, small enough to stay off the heap. */
const CHUNK = 8 * 1024 * 1024

export interface RemuxOutcome {
  file: File
  /** True when only the container changed, so nothing was re-encoded. */
  copied: boolean
}

/** The desktop shell, or null on the web build where there is no ffmpeg. */
function desktop(): NonNullable<typeof window.api> | null {
  const api = typeof window === 'undefined' ? undefined : window.api
  return api?.isElectron ? api : null
}

/**
 * Can this file be imported at all on this build?
 *
 * ⛔ THE WEB BUILD HAS NO FFMPEG, so there is nothing it can do with a .mkv and
 * saying so plainly beats a decode error from three layers down.
 */
export function canImport(fileName: string): boolean {
  return !needsRemux(fileName) || desktop() !== null
}

/**
 * Convert a recording Chromium cannot open, or hand back exactly what came in.
 *
 * ⛔ NOT A GUESS ABOUT WHETHER IT WOULD HAVE WORKED. Only the containers on the
 * `needsRemux` list go through here, so an ordinary .mp4 import does not pay a
 * single byte of copying, and a .webm is left alone because Chromium reads it.
 */
export async function remuxIfNeeded(file: File, onProgress?: (frac: number) => void): Promise<RemuxOutcome> {
  const api = desktop()
  if (!needsRemux(file.name) || !api) return { file, copied: true }

  const id = await api.remuxBegin()
  try {
    // Stream in. `file.slice` is a view, so the bytes are only read when the
    // slice is turned into a buffer, one chunk at a time.
    for (let offset = 0; offset < file.size; offset += CHUNK) {
      const slice = file.slice(offset, Math.min(offset + CHUNK, file.size))
      await api.remuxChunk(id, await slice.arrayBuffer())
      onProgress?.((offset / file.size) * 0.5)
    }

    const { size, copied } = await api.remuxFinish(id)

    // ⛔ EACH CHUNK BECOMES A Blob IMMEDIATELY, AND THAT IS THE WHOLE POINT.
    // Keeping the ArrayBuffers in an array and handing the array to `new File`
    // at the end reads like chunking but is not: every chunk stays on the JS
    // heap until the end, so a 6 GB capture costs 6 GB of heap and the files
    // this feature exists for are exactly the ones that would die. Wrapping each
    // chunk as it arrives puts the bytes in the browser's blob store, which is
    // backed by disk, and lets the ArrayBuffer be collected straight away.
    const parts: Blob[] = []
    for (let offset = 0; offset < size; offset += CHUNK) {
      parts.push(new Blob([await api.remuxRead(id, offset, Math.min(CHUNK, size - offset))]))
      onProgress?.(0.5 + (offset / size) * 0.5)
    }
    const name = file.name.replace(/\.[^.]+$/, '') + '.mp4'
    return { file: new File(parts, name, { type: 'video/mp4' }), copied }
  } finally {
    // A full sized temp on a drive that is already nearly full. It goes whether
    // this worked or not.
    await api.remuxRelease(id).catch(() => undefined)
  }
}
