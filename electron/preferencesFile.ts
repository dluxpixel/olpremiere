// His own moves, his track setups and his settings as a plain file, next to his
// project files, kept current on every change to them.
//
// ⛔ WHY: they lived only in localStorage, which sits in the same browser
// profile as the IndexedDB the engine has thrown away under him four times since
// July. A wipe brings every project back from its file and his caption styles
// back from theirs, and left the moves he performed and saved, the track setup
// new videos start from and every setting gone. Same reason, same shape, as
// captionStylesFile.ts. The renderer half is src/state/prefsHome.ts.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { projectDir } from './projectFiles'

/** `Preferences.json`, beside the `.olpbak` files, so it lives and dies with them. */
export function preferencesFilePath(): string {
  return path.join(projectDir(), 'Preferences.json')
}

/**
 * Written beside, then renamed over, for the reason writeProjectFile gives: a
 * write cut off half way must never leave half a file where the only copy was.
 * Flushed before the rename, the way the media writer is (mediaStore.ts): on
 * NTFS the rename can reach the disk before the bytes do.
 */
export async function writePreferencesFile(json: string): Promise<void> {
  const target = preferencesFilePath()
  await mkdir(path.dirname(target), { recursive: true })
  const tmp = `${target}.tmp`
  await writeFile(tmp, json, { encoding: 'utf8', flush: true })
  await rename(tmp, target)
}

/** The file's text, or null when there is none yet. */
export async function readPreferencesFile(): Promise<string | null> {
  try {
    return await readFile(preferencesFilePath(), 'utf8')
  } catch {
    return null
  }
}
