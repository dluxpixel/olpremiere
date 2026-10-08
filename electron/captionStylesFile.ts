// His caption styles as a plain file, next to his project files, kept current
// on every change to them.
//
// ⛔ WHY: the styles lived only in localStorage, which sits in the same browser
// profile as the IndexedDB the engine has thrown away under him four times since
// July. A wipe would bring every project back from its file and leave the caption
// look he built and named gone. Same reason, same shape, as libraryFile.ts.

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { projectDir } from './projectFiles'
import { replaceFile } from './replaceFile'

/** `Caption styles.json`, beside the `.olpbak` files, so it lives and dies with them. */
export function captionStylesFilePath(): string {
  return path.join(projectDir(), 'Caption styles.json')
}

/** Written whole, flushed, and one write at a time. See ./replaceFile. */
export function writeCaptionStylesFile(json: string): Promise<void> {
  return replaceFile(captionStylesFilePath(), json)
}

/** The file's text, or null when there is none yet. */
export async function readCaptionStylesFile(): Promise<string | null> {
  try {
    return await readFile(captionStylesFilePath(), 'utf8')
  } catch {
    return null
  }
}
