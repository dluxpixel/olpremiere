// One file of his written whole, and one write of it at a time. Preferences.json,
// Caption styles.json and Library.json all go through here.
//
// Written beside, then renamed over, for the reason writeProjectFile gives: a
// write cut off half way must never leave half a file where the only copy was.
// Flushed before the rename, the way the media writer is (mediaStore.ts): on
// NTFS the rename can reach the disk before the bytes do. The flush and the
// rename are durableWrite.ts's one implementation; this adds the folder and the
// queue on top of it.
//
// ⛔ ONE AT A TIME PER FILE. Every write of a file used the same `.tmp` beside
// it, and nothing in main put the writes in order, so two that overlapped (a
// slow disk, OneDrive or a virus scanner holding the first) opened that one
// temp file together. The second rename then found it gone, and in the narrow
// case where one write truncated it under the other, the file was left as one
// JSON with the tail of another, which no reader can parse. Now each write waits
// for the one before it (durableWrite.inTurn, keyed on the file), so the last
// one asked for is the one on disk. A write that failed has already said so to
// its own caller; the next one still goes.

import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { inTurn, replaceFile as writeBesideAndRename } from './durableWrite'

export function replaceFile(target: string, text: string): Promise<void> {
  return inTurn(target, async () => {
    await mkdir(path.dirname(target), { recursive: true })
    await writeBesideAndRename(target, text)
  })
}
