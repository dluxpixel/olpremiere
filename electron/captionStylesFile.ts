// His caption styles as a plain file, next to his project files, kept current
// on every change to them.
//
// ⛔ WHY: the styles lived only in localStorage, which sits in the same browser
// profile as the IndexedDB the engine has thrown away under him four times since
// July. A wipe would bring every project back from its file and leave the caption
// look he built and named gone. Same reason, same shape, as libraryFile.ts.

import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { inTurn, replaceFile } from './durableWrite'
import { projectDir } from './projectFiles'

/** `Caption styles.json`, beside the `.olpbak` files, so it lives and dies with them. */
export function captionStylesFilePath(): string {
  return path.join(projectDir(), 'Caption styles.json')
}

/**
 * Written beside, flushed, then renamed over, one write at a time, for the
 * reasons writeProjectFile gives: a write cut off half way, or a power cut, must
 * never leave half a file or a file of zeros where the only copy was.
 */
export function writeCaptionStylesFile(json: string): Promise<void> {
  return inTurn('captionStyles', async () => {
    const target = captionStylesFilePath()
    await mkdir(path.dirname(target), { recursive: true })
    await replaceFile(target, json)
  })
}

/** The file's text, or null when there is none yet. */
export async function readCaptionStylesFile(): Promise<string | null> {
  try {
    return await readFile(captionStylesFilePath(), 'utf8')
  } catch {
    return null
  }
}
