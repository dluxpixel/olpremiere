// One file of his written whole, and one write of it at a time. Preferences.json,
// Caption styles.json and Library.json all go through here.
//
// Written beside, then renamed over, for the reason writeProjectFile gives: a
// write cut off half way must never leave half a file where the only copy was.
// Flushed before the rename, the way the media writer is (mediaStore.ts): on
// NTFS the rename can reach the disk before the bytes do.
//
// ⛔ ONE AT A TIME PER FILE. Every write of a file used the same `.tmp` beside
// it, and nothing in main put the writes in order, so two that overlapped (a
// slow disk, OneDrive or a virus scanner holding the first) opened that one
// temp file together. The second rename then found it gone, and in the narrow
// case where one write truncated it under the other, the file was left as one
// JSON with the tail of another, which no reader can parse. Now each write waits
// for the one before it, so the last one asked for is the one on disk.

import { mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** The last write asked for, per file. Settles once it is down or has failed. */
const queues = new Map<string, Promise<void>>()

export function replaceFile(target: string, text: string): Promise<void> {
  const write = async (): Promise<void> => {
    await mkdir(path.dirname(target), { recursive: true })
    const tmp = `${target}.tmp`
    await writeFile(tmp, text, { encoding: 'utf8', flush: true })
    await rename(tmp, target)
  }
  // A write that failed has already said so to its own caller; the next one
  // still goes.
  const mine = (queues.get(target) ?? Promise.resolve()).then(write)
  const settled = mine.catch(() => undefined)
  queues.set(target, settled)
  void settled.then(() => {
    if (queues.get(target) === settled) queues.delete(target)
  })
  return mine
}
