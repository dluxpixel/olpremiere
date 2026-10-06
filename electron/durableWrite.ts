// Writing one of his small files (a project, the Library, his caption styles) so
// that neither a crash nor two saves at once can leave it empty or mixed.
//
// Its own module, free of 'electron', so the order of the steps runs under test.

import { rename, writeFile } from 'node:fs/promises'

/**
 * Write `text` beside `target`, flush it to the disk, and only then rename it over.
 *
 * ⛔ THE FLUSH IS THE POINT. The rename alone protects against the APP dying half
 * way. It does not protect against the MACHINE dying: NTFS journals the rename
 * and the file's length well before the bytes themselves, so a power cut or a
 * blue screen right after a save can leave a full length file of zeros under
 * the real name (the same reason finishMedia in mediaStore.ts flushes). A power
 * cut is also the classic morning the browser store is thrown away, which is
 * the morning this file is the only copy of his project.
 */
export async function replaceFile(target: string, text: string): Promise<void> {
  const tmp = `${target}.tmp`
  await writeFile(tmp, text, { encoding: 'utf8', flush: true })
  await rename(tmp, target)
}

const queues = new Map<string, Promise<void>>()

/**
 * Run `job` once every earlier job for `key` has finished, failed or not.
 *
 * ⛔ ONE WRITE AT A TIME PER FILE. Every write of one file uses the same temp
 * name, and an autosave can be on its way while filing the open project under
 * Later writes it again. Two writers on one temp file can leave mixed bytes that
 * are then renamed over the good file.
 */
export function inTurn<T>(key: string, job: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(job)
  const settled = run.then(
    () => undefined,
    () => undefined,
  )
  queues.set(key, settled)
  void settled.then(() => {
    if (queues.get(key) === settled) queues.delete(key)
  })
  return run
}
