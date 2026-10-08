// His Library (saved media, categories, effect presets) as a plain file, next
// to his project files, kept current on every Library change.
//
// ⛔ WHY, MEASURED 2026-10-01: the Library lived only in IndexedDB, the store
// the browser engine has thrown away under him four times since July. A wipe
// like the one of 2026-08-23 brought every project back from its file and its
// media back from the spare copies, and left the Library empty: the music he
// had filed under "Battle Cats" was simply gone. Projects got a second home on
// 2026-09-14 (projectFiles.ts); the Library never did.
//
// The records only. The Library's media bytes go to the same spare-copy folder
// as project media (mediaStore.ts), under `lib-<item id>`, and come back from
// there when this file is read back.

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { projectDir } from './projectFiles'
import { replaceFile } from './replaceFile'

/** `Library.json`, beside the `.olpbak` files, so it lives and dies with them. */
export function libraryFilePath(): string {
  return path.join(projectDir(), 'Library.json')
}

/** Written whole, flushed, and one write at a time. See ./replaceFile. */
export function writeLibraryFile(json: string): Promise<void> {
  return replaceFile(libraryFilePath(), json)
}

/** The file's text, or null when there is none yet. */
export async function readLibraryFile(): Promise<string | null> {
  try {
    return await readFile(libraryFilePath(), 'utf8')
  } catch {
    return null
  }
}
