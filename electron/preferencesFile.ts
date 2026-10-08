// His own moves, his track setups and his settings as a plain file, next to his
// project files, kept current on every change to them.
//
// ⛔ WHY: they lived only in localStorage, which sits in the same browser
// profile as the IndexedDB the engine has thrown away under him four times since
// July. A wipe brings every project back from its file and his caption styles
// back from theirs, and left the moves he performed and saved, the track setup
// new videos start from and every setting gone. Same reason, same shape, as
// captionStylesFile.ts. The renderer half is src/state/prefsHome.ts.

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { projectDir } from './projectFiles'
import { replaceFile } from './replaceFile'

/** `Preferences.json`, beside the `.olpbak` files, so it lives and dies with them. */
export function preferencesFilePath(): string {
  return path.join(projectDir(), 'Preferences.json')
}

/** Written whole, flushed, and one write at a time. See ./replaceFile. */
export function writePreferencesFile(json: string): Promise<void> {
  return replaceFile(preferencesFilePath(), json)
}

/**
 * The file's text, or null when there is none yet.
 *
 * ⛔ NULL ONLY FOR NO FILE AT ALL. Anything else (another program holding it, a
 * cloud placeholder that cannot be fetched offline) rejects: the file is there,
 * it may hold the only copy of his moves, and the renderer leaves alone a file
 * it could not read. Read as "no file", it was written over from a wiped
 * profile by his first change of a setting.
 */
export async function readPreferencesFile(): Promise<string | null> {
  try {
    return await readFile(preferencesFilePath(), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return null
    throw err
  }
}
